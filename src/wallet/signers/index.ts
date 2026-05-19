import { KnownOrdinalWalletType, WalletSigner } from '../wallet.service.types';
import { leatherSigner } from './leather.signer';
import { psbtExportSigner } from './psbt-export.signer';
import { unisatSigner } from './unisat.signer';
import { xverseSigner } from './xverse.signer';


/**
 * Sign-side wallet roster. Narrow on purpose — only wallets we have
 * byte-snapshot tests and a manual smoke test for. New entries get
 * a corresponding `WalletSigner` file + spec, then land here.
 *
 * `psbtExportSigner` is the universal watch-only signer (Sparrow,
 * Electrum, Coldcard, Ledger, Trezor, …). It covers any wallet that
 * speaks PSBT but doesn't inject JS into the browser.
 *
 * Read roster lives in `connectors/` and is allowed to be broad.
 */
export const walletSigners: readonly WalletSigner[] = [
  xverseSigner,
  leatherSigner,
  unisatSigner,
  psbtExportSigner,
];

/**
 * Returns the signer for the given wallet type, or `undefined` if
 * no matching signer is registered. Callers that need a hard
 * guarantee should look up via {@link findSignerOrThrow}.
 */
export function findSigner(type: KnownOrdinalWalletType): WalletSigner | undefined {
  return walletSigners.find(s => s.providerId === type);
}

export function findSignerOrThrow(type: KnownOrdinalWalletType): WalletSigner {
  const signer = findSigner(type);
  if (!signer) {
    throw new Error(`No signer registered for wallet type: ${type as string}`);
  }
  return signer;
}

export { leatherSigner } from './leather.signer';
export { psbtExportSigner } from './psbt-export.signer';
export { unisatSigner } from './unisat.signer';
export { xverseSigner } from './xverse.signer';
