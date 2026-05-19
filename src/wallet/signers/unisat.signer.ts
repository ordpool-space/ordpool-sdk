import { hex } from '@scure/base';
import { from, map, Observable } from 'rxjs';

import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';


interface UnisatRpc {
  signPsbt(psbtHex: string): Promise<string>;
  pushPsbt(psbtHex: string): Promise<string>;
}


/**
 * Unisat — `window.unisat.signPsbt(hex)` + `window.unisat.pushPsbt(hex)`.
 *
 * Unisat returns the signed PSBT to us, then we hand it back for the
 * broadcast in a second call. Both happen inside the wallet, so the
 * input's `broadcast` callback is unused. From the caller's
 * perspective the operation is atomic.
 *
 * Caveat (CLAUDE.md): Unisat uses one address for both payments and
 * ordinals — easy to spend cat sats by accident. Mint flow surfaces
 * this in UI text. The signer itself can't help that.
 *
 * See:
 *  - https://github.com/unisat-wallet/unisat-web3-demo/blob/1109c79b/src/App.tsx#L208
 *  - https://github.com/unisat-wallet/unisat-web3-demo/blob/1109c79b/src/App.tsx#L313
 */
export const unisatSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.unisat,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex: string = hex.encode(input.psbtBytes);
    const unisat = (window as unknown as { unisat: UnisatRpc }).unisat;

    const promise = unisat.signPsbt(psbtHex)
      .then(signed => unisat.pushPsbt(signed));

    return from(promise).pipe(map(txId => ({ txId })));
  },
};
