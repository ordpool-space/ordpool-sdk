import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import {
  catchError,
  concatMap,
  forkJoin,
  interval,
  map,
  mergeMap,
  Observable,
  of,
  shareReplay,
  startWith,
  switchMap,
  tap,
  throwError,
  timer,
  toArray,
} from 'rxjs';

import { Network, toScureNetwork } from '../network';
import { findSignerOrThrow } from '../wallet/signers';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { Cat21SdkConfig } from './cat21-sdk-config';
import { fetchJson, fetchText, postText } from './http-fetch.helper';
import {
  createTransaction,
  getDummyKeypair,
  isSegWit,
  simulateMintTransaction,
} from './cat21.service.helper';
import {
  MempoolTx,
  PendingMint,
  RecommendedFees,
  SimulateTransactionResult,
  TxnOutput,
} from './cat21.service.types';
import {
  gcFirstSeen,
  selectMatchingPendingMints,
} from './pending-mints.helper';

/**
 * How often `pendingMints$` polls electrs for each subscribed address
 * set. 30s is the documented cadence in PLAN-cat21-mint-port.md;
 * mempool turnover for CAT-21 mints is on the order of minutes so this
 * gives a quick-enough surface without hammering the upstream.
 */
const PENDING_MINTS_POLL_MS = 30_000;

/**
 * How often `recommendedFees$` polls the mempool fees endpoint. Same
 * 30s cadence — the user picks a fee once per mint, the value only
 * needs to be reasonably fresh.
 */
const RECOMMENDED_FEES_POLL_MS = 30_000;


/**
 * Stateful `Observable`-returning client for the CAT-21 mint flow (utxo
 * lookups, raw-tx fetch, broadcast, mempool polling, PSBT build + sign). Plain
 * class: the consumer passes the SDK config + network to the constructor and
 * owns the instance. HTTP is native `fetch` (via `http-fetch.helper`); RxJS is
 * the reactivity surface, so any consumer (a frontend, a bot, a CLI) subscribes
 * the same way.
 */
export class Cat21Service {

  private readonly network: Network;
  readonly mempoolApiUrl: string;
  readonly recommendedFees$: Observable<RecommendedFees>;

  private txHexCache: { [transactionId: string]: string } = {}; // Cache object

  constructor(config: Cat21SdkConfig, network: Network) {
    this.network = network;
    this.mempoolApiUrl = config.mempoolApiUrl;
    // Assigned here (not as a field initializer) so `mempoolApiUrl` is set
    // first — field initializers would run before the constructor sets it.
    this.recommendedFees$ = interval(RECOMMENDED_FEES_POLL_MS).pipe(
      startWith(0),
      switchMap(() => fetchJson<RecommendedFees>(`${this.mempoolApiUrl}/api/v1/fees/recommended`)),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  }

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
      // Observable-error, NOT a synchronous throw: `switchMap` /
      // `combineLatest` catchError chains upstream only see errors
      // that come through the Observable, and orchestrator's
      // `utxos$` sticks in `loading-utxos` forever if this factory
      // throws before returning an Observable.
      return throwError(() => new Error('No wallet connected'));
    }

    const $utxos = fetchJson<TxnOutput[]>(`${this.mempoolApiUrl}/api/address/${address}/utxo`);

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

    return fetchText(`${this.mempoolApiUrl}/api/tx/${transactionId}/hex`).pipe(
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
    return postText(`${this.mempoolApiUrl}/api/tx`, hexPayload);
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
    // Delegates to the framework-agnostic helper — one implementation shared
    // with the wallet + every other consumer (`simulateMintTransaction`).
    return simulateMintTransaction(
      walletType,
      recipientAddress,
      paymentOutput,
      paymentAddress,
      paymentPublicKey,
      transactionFee,
      this.network,
    );
  }

  /**
   * Parse a PSBT, dummy-sign input 0 with the well-known dummy key,
   * finalise, and return the scure Transaction. Used to measure a
   * candidate tx's vsize during fee resolution (`resolveCatTxFee`).
   *
   * The dummy key is the SDK's well-known fixed key (`getDummyKeypair`);
   * the signature is structurally valid (correct DER length, correct
   * sighash byte) so `tx.vsize` matches what a real-signed tx would
   * have. Only used in simulation paths; never broadcast.
   */
  dummySignAndFinalize(psbtBytes: Uint8Array): btc.Transaction {
    const tx = btc.Transaction.fromPSBT(psbtBytes);
    const { dummyPrivateKey } = getDummyKeypair(toScureNetwork(this.network));
    tx.signIdx(dummyPrivateKey, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
    tx.finalize();
    return tx;
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
    transactionFee: bigint,

    // Watch-only (xpub) signers bridge to user-mediated signing via this
    // export/paste callback; injected browser-wallet signers ignore it.
    // Required for a `xpub` wallet — psbtExportSigner throws without it.
    promptForSignedPsbt?: (unsigned: { base64: string; hex: string }) => Observable<string>,
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
    const result = signer.signSingleFundingInput({
      psbtBytes,
      paymentAddress,
      // Enables the wallet-side-address shim so Unisat/Wizz/OKX see
      // their mainnet-view address in `toSignInputs` even when the app
      // carries a bcrt address on regtest. On mainnet the app address
      // already IS the mainnet address, so this is a no-op there. Same
      // wiring the inscribe orchestrator uses.
      paymentPublicKey: hex.encode(paymentPublicKey),
      network: this.network,
      broadcast: (txHex: string) => this.postTransaction(txHex),
      promptForSignedPsbt,
    });

    return result;
  }

  /**
   * Stream of CAT-21 mints currently in the mempool whose first output
   * is addressed to one of the supplied addresses.
   *
   * Polls electrs every 30s for as long as anyone is subscribed. The
   * SDK does NOT auto-stop on wallet disconnect — the consumer
   * unsubscribes (e.g. by switching to a fresh observable when the
   * wallet changes, or destroying the component) to stop polling.
   *
   * Cross-device awareness: because the source of truth is the
   * mempool (not localStorage), a mint started from another device is
   * picked up by the next poll cycle.
   *
   * Empty `addresses` returns `of([])` immediately — no polling, no
   * subscription overhead. Useful when a component renders before a
   * wallet is connected.
   *
   * Each call to this method returns a fresh observable with its own
   * polling chain. Multiple subscribers of the SAME returned
   * observable share the chain via `shareReplay({refCount:true})`.
   */
  pendingMints$(addresses: string[]): Observable<PendingMint[]> {
    if (addresses.length === 0) return of([]);

    const querySet = new Set(addresses);
    // First-seen timestamps, kept in the closure across poll cycles
    // so a tx that's been in the mempool for several intervals reports
    // when we first saw it — not when the latest poll fired.
    const firstSeen = new Map<string, string>();

    return interval(PENDING_MINTS_POLL_MS).pipe(
      startWith(0),
      switchMap(() => {
        const requests = addresses.map((addr) =>
          fetchJson<MempoolTx[]>(`${this.mempoolApiUrl}/api/address/${addr}/txs/mempool`)
            .pipe(catchError(() => of([] as MempoolTx[]))),
        );
        return forkJoin(requests);
      }),
      map((arrays) => {
        const nowIso = new Date().toISOString();
        const result = selectMatchingPendingMints(arrays, querySet, firstSeen, nowIso);

        // GC entries that left the mempool (mined) so the closure
        // doesn't accumulate stale txids across a long session.
        const currentIds = new Set<string>();
        for (const arr of arrays) for (const tx of arr) currentIds.add(tx.txid);
        gcFirstSeen(firstSeen, currentIds);

        return result;
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  }
}
