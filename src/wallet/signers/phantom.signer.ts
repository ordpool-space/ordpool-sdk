import { from, Observable, switchMap } from 'rxjs';

import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';


interface PhantomBitcoinRpc {
  request(args: {
    method: 'btc_signPSBT';
    params: [Uint8Array, {
      inputsToSign: { address: string; signingIndexes: number[]; sigHash?: number }[];
      finalize: boolean;
    }];
  }): Promise<Uint8Array>;
}


/**
 * Phantom — `window.phantom.bitcoin.request({method:"btc_signPSBT",
 * params:[bytes, {inputsToSign, finalize:false}]})`.
 *
 * Phantom is a multi-chain wallet whose BTC sub-provider speaks
 * JSON-RPC. The `btc_signPSBT` method takes the PSBT as Uint8Array
 * (not hex/base64) and an `inputsToSign` array shaped like sats-
 * connect's. Schema verified by grepping btc.js v26.14.0:
 *   params: [Uint8Array, { inputsToSign[], finalize: boolean }]
 *   result: Uint8Array (signed PSBT bytes)
 *
 * Per the SDK-wide "WE broadcast" convention, we pass `finalize:
 * false` and route through the shared broadcastSignedPsbt helper.
 * Phantom doesn't expose a `btc_sendPSBT` equivalent — broadcast
 * is always the SDK's job, which matches our convention exactly.
 *
 * SIGHASH_ALL = 1.
 */
export const phantomSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.phantom,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const phantomBtc = (window as unknown as { phantom: { bitcoin: PhantomBitcoinRpc } }).phantom.bitcoin;

    const signPromise = phantomBtc.request({
      method: 'btc_signPSBT',
      params: [
        input.psbtBytes,
        {
          inputsToSign: [{
            address: input.paymentAddress,
            signingIndexes: [0],
            sigHash: 0x01, // SIGHASH_ALL
          }],
          finalize: false,
        },
      ],
    });

    return from(signPromise).pipe(
      switchMap(signedPsbtBytes => broadcastSignedPsbt(input, signedPsbtBytes)),
    );
  },
};
