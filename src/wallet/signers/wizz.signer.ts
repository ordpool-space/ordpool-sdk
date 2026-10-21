import { KnownOrdinalWalletType, WalletSigner } from '../wallet.service.types.js';
import { makeUnisatFamilySigner, UnisatFamilyRpc } from './unisat-family-signer.helper.js';
import { unsupportedSignMessage } from './unsupported-sign-message.js';


/**
 * Wizz — `window.wizz.signPsbt(hex, {autoFinalized: false})`.
 *
 * Wizz is a fork of UniSat (formerly Atom Wallet) and exposes the same
 * provider contract, so it rides the shared UniSat-family signer. Per the
 * SDK-wide "WE broadcast" convention we SKIP `pushPsbt` (Wizz's vendor
 * backend) and broadcast via the caller's callback.
 *
 * Wizz also injects itself as `window.atom` (legacy Atom namespace) for
 * backwards compatibility; both bindings reference the same provider via
 * Proxy. Prefer `window.wizz`.
 */
export const wizzSigner: WalletSigner = makeUnisatFamilySigner({
  walletType: KnownOrdinalWalletType.wizz,
  getProvider: () => (window as unknown as { wizz: UnisatFamilyRpc }).wizz,
  shimWalletAddress: true,
  signMessage: unsupportedSignMessage('Wizz'),
});
