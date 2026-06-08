import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import * as btc from '@scure/btc-signer';
import { concatMap, map, mergeMap, Observable, of, tap, timer, toArray } from 'rxjs';

import { toScureNetwork } from '../network';
import { bitcoinNetwork } from '../network-token';
import { findSignerOrThrow } from '../wallet/signers';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { cat21Config } from './cat21-sdk-config';
import {
  createTransaction,
  getDummyKeypair,
  isSegWit,
} from './cat21.service.helper';
import { SimulateTransactionResult, TxnOutput } from './cat21.service.types';


@Injectable({ providedIn: 'root' })
export class Cat21Service {

  private config = inject(cat21Config);
  private network = inject(bitcoinNetwork);
  mempoolApiUrl = this.config.mempoolApiUrl;

  http = inject(HttpClient);

  private txHexCache: { [transactionId: string]: string } = {}; // Cache object

  /**
   * Get the list of unspent transaction outputs associated with the address/scripthash.
   * Available fields: txid, vout, value, and status (with the status of the funding tx).
   *
   * If the address is non-segwit, then we als fetch the transaction hex to be able
   * to construct the input later on
   *
   * @param address The Bitcoin address to query.
   * @returns An Observable of UTXO array.
   * @see https://github.com/Blockstream/esplora/blob/master/API.md#get-addressaddressutxo
   */
  public getUtxos(address: string): Observable<TxnOutput[]> {

    if (!address) {
      throw new Error('No wallet connected');
    }

    const $utxos = this.http.get<TxnOutput[]>(`${this.mempoolApiUrl}/api/address/${address}/utxo`);

    if (isSegWit(address)) {
      return $utxos;
    }

    return $utxos.pipe(
      mergeMap(utxos => utxos), // Flatten the array to individual UTXOs
      concatMap(utxo =>
        timer(200).pipe( // Wait for 200ms to avaid
          mergeMap(() => this.getTransactionHex(utxo.txid)),
          map(transactionHex => ({
            ...utxo,
            transactionHex
          }))
        )
      ),
      toArray() // Re-collect the processed UTXOs into an array
    );
  }

  /**
   * Returns a transaction serialized as hex (cached).
   * @param transactionId The Bitcoin transaction ID.
   * @returns An Observable of the transaction serialized as a hex string.
   * @see https://github.com/Blockstream/esplora/blob/master/API.md#get-txtxidhex
   */
  public getTransactionHex(transactionId: string): Observable<string> {

    const cachedHex = this.txHexCache[transactionId];
    if (cachedHex) {
      return of(cachedHex);
    }

    return this.http.get(`${this.mempoolApiUrl}/api/tx/${transactionId}/hex`, {
      responseType: 'text'
    }).pipe(
      tap((hex) => {
        this.txHexCache[transactionId] = hex;
      })
    );
  }

  /**
   * POST /tx
   * Broadcast a raw transaction to the network.
   * @param hexPayload The transaction should be provided as hex in the request body.
   * @returns The txid will be returned on success.
   * @see https://github.com/Blockstream/esplora/blob/master/API.md#post-tx
   */
  postTransaction(hexPayload: string): Observable<string> {
    return this.http.post<string>(`${this.mempoolApiUrl}/api/tx`, hexPayload, { responseType: 'text' as 'json'});
  }

  /**
   * Constructs a fake CAT-21 mint transaction,
   * finalizes the txn and receives the vsize
   *
   * Throws an Error if paymentOutput has not enough funds!
   * - 'Insufficient funds for transaction' via the createTransaction
   * - 'Outputs spends more than inputs amount' when we finalize (second safety net)
   */
  simulateTransaction(
    walletType: KnownOrdinalWalletType,
    recipientAddress: string,

    paymentOutput: TxnOutput,
    paymentAddress: string,
    paymentPublicKey: Uint8Array,
    transactionFee: bigint
  ): SimulateTransactionResult {

    const { dummyPrivateKey } = getDummyKeypair(toScureNetwork(this.network));

    const result = createTransaction(
      walletType,
      recipientAddress,
      paymentOutput,
      paymentPublicKey,
      paymentAddress,
      transactionFee,
      true, // simulation
      this.network
    );

    result.tx.signIdx(dummyPrivateKey, 0, [btc.SigHash.ALL]);
    result.tx.finalize();
    const vsize = result.tx.vsize; // 🎉

    return {
      ...result,
      vsize
    };
  }

  /**
   * Constructs a PSBT with a CAT-21 mint transaction,
   * prompts the user to sign it and broadcasts the transaction.
   *
   * Emits the broadcast `txId` and nothing else — the consumer already
   * has every other field it passed in (wallet, addresses) and the
   * network is known from the injected `bitcoinNetwork` token. Pending
   * mempool tracking after broadcast is the consumer's job (see
   * `pendingMints$`).
   */
  createCat21Transaction(
    walletType: KnownOrdinalWalletType,
    recipientAddress: string,

    paymentOutput: TxnOutput,
    paymentAddress: string,
    paymentPublicKey: Uint8Array,
    transactionFee: bigint
  ): Observable<{ txId: string }> {

    // create the real transaction
    const { tx } = createTransaction(
      walletType,
      recipientAddress,

      paymentOutput,
      paymentPublicKey,
      paymentAddress,
      transactionFee,
      false, // no simulation
      this.network
    );

    // PSBT as Uint8Array
    const psbtBytes = tx.toPSBT(0);

    const signer = findSignerOrThrow(walletType);
    const result = signer.signAndBroadcast({
      psbtBytes,
      paymentAddress,
      network: this.network,
      broadcast: (txHex: string) => this.postTransaction(txHex),
    });

    return result;
  }
}
