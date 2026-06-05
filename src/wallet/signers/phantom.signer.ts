import { from, Observable, switchMap } from 'rxjs';

import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';


interface PhantomBitcoinSigner {
  signPSBT(
    psbtBytes: Uint8Array,
    opts: {
      inputsToSign: { address: string; signingIndexes: number[]; sigHash?: number }[];
      finalize: boolean;
    },
  ): Promise<Uint8Array>;
}


/**
 * Phantom — `window.phantom.bitcoin.signPSBT(psbtBytes,
 * {inputsToSign, finalize: false})`.
 *
 * Phantom's in-page BTC provider exposes signPSBT() as a direct
 * method (NOT a generic `request({method, params})` RPC). Verified
 * by disassembling btc.js v26.14.0 — class Lh defines `signPSBT =
 * async (e, t) => (t.finalize = t.finalize ?? false, await
 * this.#s({method:"btc_signPSBT", params:[e, t]}))` at byte ~471900.
 * The JSON-RPC method name "btc_signPSBT" is internal to the in-
 * page proxy; the page-level API takes the bytes + opts directly.
 *
 * Per the SDK-wide "WE broadcast" convention, we pass `finalize:
 * false` and route through the shared broadcastSignedPsbt helper.
 *
 * SIGHASH_ALL = 1.
 */
export const phantomSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.phantom,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const phantomBtc = (window as unknown as { phantom: { bitcoin: PhantomBitcoinSigner } }).phantom.bitcoin;

    const signPromise = phantomBtc.signPSBT(
      input.psbtBytes,
      {
        inputsToSign: [{
          address: input.paymentAddress,
          signingIndexes: [0],
          sigHash: 0x01, // SIGHASH_ALL
        }],
        finalize: false,
      },
    );

    return from(signPromise).pipe(
      switchMap(signedPsbtBytes => broadcastSignedPsbt(input, signedPsbtBytes)),
    );
  },
};
