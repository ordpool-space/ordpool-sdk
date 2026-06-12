import { KnownOrdinalWalletType, WalletSigner } from '../wallet.service.types';
import { leatherSigner } from './leather.signer';
import { okxSigner } from './okx.signer';
import { oylSigner } from './oyl.signer';
import { psbtExportSigner } from './psbt-export.signer';
import { unisatSigner } from './unisat.signer';
import { wizzSigner } from './wizz.signer';
import { xverseSigner } from './xverse.signer';


/**
 * Sign-side wallet roster. Gating bar per CLAUDE.md "CI is the
 * test, no manual smoke": entries here have a green Pipeline B
 * mint-roundtrip in `e2e/playwright/specs/<wallet>-mint-roundtrip
 * .spec.ts` running against the real .crx + regtest stack in CI.
 *
 * Current entries pass that bar:
 *   xverse / leather / unisat / okx / oyl / wizz
 *
 * `psbtExportSigner` is the universal watch-only signer (Sparrow,
 * Electrum, Coldcard, Ledger, Trezor, …). It covers any wallet that
 * speaks PSBT but doesn't inject JS into the browser. No Pipeline
 * B mint-roundtrip needed because there's no browser provider to
 * drive — coverage is via the standalone psbt-export.signer.angular
 * .spec.ts.
 *
 * Wallets with a signer file but NOT yet in the roster (blocked on
 * CI evidence, not on a human-smoke prerequisite):
 *   - alby: no alby-mint-roundtrip spec exists. Alby Browser
 *     Extension delegates signPsbt to whatever on-chain backend
 *     the user wired (Alby Hub / Mutiny / …). Building a Pipeline
 *     B mint-roundtrip means standing up an Alby Hub instance in
 *     CI — possible but non-trivial. Land when the spec lands
 *     green.
 *   - phantom: phantom-mint-roundtrip exists but is skipped
 *     because Phantom's current desktop binary ships btc.js
 *     dormant (v26.x confirmed). The signer file matches the
 *     documented API for the eventual reactivation; land when CI
 *     can actually exercise it.
 *
 * Read roster lives in `connectors/` and is allowed to be broad —
 * detect-by-signature surfaces whatever the user has installed,
 * and the signer roster is the narrower "we can actually drive
 * this end-to-end" set.
 */
export const walletSigners: readonly WalletSigner[] = [
  xverseSigner,
  leatherSigner,
  unisatSigner,
  okxSigner,
  oylSigner,
  wizzSigner,
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
export { okxSigner } from './okx.signer';
export { oylSigner } from './oyl.signer';
export { psbtExportSigner } from './psbt-export.signer';
export { unisatSigner } from './unisat.signer';
export { wizzSigner } from './wizz.signer';
export { xverseSigner } from './xverse.signer';
