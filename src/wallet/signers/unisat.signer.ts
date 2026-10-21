import { Observable } from 'rxjs';

import {
  KnownOrdinalWalletType,
  SignMessageArgs,
  SignMessageResult,
  WalletSigner,
} from '../wallet.service.types.js';
import { makeUnisatFamilySigner, UnisatFamilyRpc } from './unisat-family-signer.helper.js';
import { wrapSignMessage } from './wrap-sign-message.js';


interface UnisatRpc extends UnisatFamilyRpc {
  /**
   * Sign a message under the currently-selected address. `type =
   * 'bip322-simple'` returns a base64 BIP-322 witness (what we want);
   * `'ecdsa'` returns the older Sparrow-format ECDSA sig that
   * verifyListingSignature does NOT accept.
   */
  signMessage(message: string, type?: 'ecdsa' | 'bip322-simple'): Promise<string>;
}


/**
 * UniSat — `window.unisat.signPsbt(hex, {autoFinalized: false})`.
 *
 * Speaks the shared UniSat-family contract (see `makeUnisatFamilySigner`):
 * the wallet signs and hands back a partial-sig PSBT, the SDK finalises and
 * broadcasts. We deliberately SKIP `window.unisat.pushPsbt` (Unisat's vendor
 * backend api.unisat.io), which would take broadcast-endpoint choice away from
 * the SDK and break regtest / Mara / accelerator scenarios.
 *
 * Caveat (CLAUDE.md): UniSat uses one address for both payments and ordinals,
 * so it is easy to spend cat sats by accident. The mint flow surfaces this in
 * UI text; the signer itself cannot help that.
 */
export const unisatSigner: WalletSigner = makeUnisatFamilySigner({
  walletType: KnownOrdinalWalletType.unisat,
  getProvider: () => (window as unknown as { unisat: UnisatRpc }).unisat,
  shimWalletAddress: true,
  /**
   * BIP-322 message signing via `window.unisat.signMessage(msg,
   * 'bip322-simple')`. Signs under the currently-selected address; UniSat's
   * single-address model means ordinals and payment are the same key, so
   * either address yields the same signature. Returns the base64 witness.
   */
  signMessage: (input: SignMessageArgs): Observable<SignMessageResult> => {
    const unisat = (window as unknown as { unisat: UnisatRpc }).unisat;
    return wrapSignMessage(() => unisat.signMessage(input.message, 'bip322-simple'));
  },
});
