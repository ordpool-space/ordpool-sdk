import { hex } from '@scure/base';
import { from, Observable, switchMap } from 'rxjs';

import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';


interface OkxBtcRpc {
  signPsbt(psbtHex: string, options?: { autoFinalized?: boolean; from?: string }): Promise<string>;
}


/**
 * OKX — `window.okxwallet.bitcoin.signPsbt(hex, {autoFinalized:
 * false})`.
 *
 * OKX is a multi-chain wallet; the BTC sub-provider lives at
 * `window.okxwallet.bitcoin`. Its signPsbt accepts the same
 * `autoFinalized` option as Unisat (verified by grepping
 * inpage.js v4.1.0). Per the SDK-wide "WE broadcast" convention,
 * we skip OKX's `sendPsbt` and broadcast via the caller-supplied
 * `input.broadcast` callback.
 */
export const okxSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.okx,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex: string = hex.encode(input.psbtBytes);
    const okxBtc = (window as unknown as { okxwallet: { bitcoin: OkxBtcRpc } }).okxwallet.bitcoin;

    return from(okxBtc.signPsbt(psbtHex, { autoFinalized: false })).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },
};
