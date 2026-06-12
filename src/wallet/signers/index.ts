import { KnownOrdinalWalletType, WalletSigner } from '../wallet.service.types';
import { albySigner } from './alby.signer';
import { binanceSigner } from './binance.signer';
import { leatherSigner } from './leather.signer';
import { okxSigner } from './okx.signer';
import { oylSigner } from './oyl.signer';
import { phantomSigner } from './phantom.signer';
import { psbtExportSigner } from './psbt-export.signer';
import { unisatSigner } from './unisat.signer';
import { wizzSigner } from './wizz.signer';
import { xverseSigner } from './xverse.signer';


/**
 * Sign-side wallet roster. Per CLAUDE.md "Ship every signer we
 * have code for": every WalletSigner file in this directory is
 * registered here. No second-gate filtering on top of
 * detect-by-signature.
 *
 * The wallet picker surfaces a wallet IF `window.<wallet>` is
 * present at runtime. If a user reaches the signer call, detect
 * already said yes. The registry's only job is to provide the
 * call shape — Pipeline B evidence about whether a particular
 * shipped binary honours that shape lives in skip-comments on
 * the e2e specs and docstrings on the signer files, NOT here.
 *
 * Known runtime caveats (see each signer file for details):
 *   - phantom: current desktop binary ships btc.js dormant
 *     (v26.x), so detect returns false on desktop and the
 *     signer isn't reached. Phantom mobile in-app browser is
 *     documented to expose `window.phantom.bitcoin`; signer is
 *     ready for that case automatically.
 *   - alby: signPsbt delegates to whatever on-chain backend the
 *     user wired (Alby Hub / Mutiny / …). Users without one
 *     get a runtime error from the wallet.
 *
 * `psbtExportSigner` is the universal watch-only signer (Sparrow,
 * Electrum, Coldcard, Ledger, Trezor, …). It covers any wallet
 * that speaks PSBT but doesn't inject JS into the browser.
 *
 * Read roster lives in `connectors/` and uses the same one-rule
 * gating (detect-by-signature).
 */
export const walletSigners: readonly WalletSigner[] = [
  xverseSigner,
  leatherSigner,
  unisatSigner,
  okxSigner,
  oylSigner,
  wizzSigner,
  phantomSigner,
  albySigner,
  binanceSigner,
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

export { albySigner } from './alby.signer';
export { binanceSigner } from './binance.signer';
export { leatherSigner } from './leather.signer';
export { okxSigner } from './okx.signer';
export { oylSigner } from './oyl.signer';
export { phantomSigner } from './phantom.signer';
export { psbtExportSigner } from './psbt-export.signer';
export { unisatSigner } from './unisat.signer';
export { wizzSigner } from './wizz.signer';
export { xverseSigner } from './xverse.signer';
