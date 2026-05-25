import { hex } from '@scure/base';
import { from, Observable, switchMap } from 'rxjs';

import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';


interface UnisatRpc {
  signPsbt(psbtHex: string, options?: { autoFinalized?: boolean }): Promise<string>;
}


/**
 * Unisat — `window.unisat.signPsbt(hex, {autoFinalized: false})`.
 *
 * Per the SDK-wide "WE broadcast" convention (see
 * `/Work/ordpool/WALLETS.md`): the wallet signs and hands back a
 * partial-sig PSBT; the SDK finalises and broadcasts via the
 * caller-supplied `input.broadcast` callback. We deliberately
 * SKIP `window.unisat.pushPsbt` — that would route to Unisat's
 * vendor backend (api.unisat.io), which takes broadcast-endpoint
 * choice away from the SDK and breaks regtest / Mara / accelerator
 * scenarios.
 *
 * Caveat (CLAUDE.md): Unisat uses one address for both payments and
 * ordinals — easy to spend cat sats by accident. Mint flow surfaces
 * this in UI text. The signer itself can't help that.
 */
export const unisatSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.unisat,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex: string = hex.encode(input.psbtBytes);
    const unisat = (window as unknown as { unisat: UnisatRpc }).unisat;

    return from(unisat.signPsbt(psbtHex, { autoFinalized: false })).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },
};
