/**
 * `ordpool-sdk/core` — the SDK's pure-functional entry point.
 *
 * Re-exports only the helpers, constants and types that have ZERO
 * runtime dependency on Angular. Consumers without an Angular runtime
 * (the cat21-wallet Chrome extension, CLIs, GitHub Actions, any plain
 * Node service) import from here:
 *
 *     import { buildCat21TransferPsbt } from 'ordpool-sdk/core';
 *
 * The main entry point (`ordpool-sdk`) still re-exports everything in
 * this file PLUS the Angular-aware services (`WalletService`,
 * `Cat21Service`, `Cat21MintOrchestrator`, etc.) for cat21.space and
 * any other Angular consumer.
 *
 * Convention: when adding a new pure helper to the SDK, export it from
 * its own file as usual AND add a re-export here. Adding an Angular
 * dependency to a file already re-exported from this entry point is a
 * structural regression — the architecture spec in the cat21-wallet
 * repo (apps/extension/src/__architecture__/architecture.spec.ts)
 * pins that all wallet imports of SDK symbols go through `'ordpool-
 * sdk/core'`, never through bare `'ordpool-sdk'`.
 */

// --- Protocol-wide constants (postage, lockTime, per-wallet sequence) ---
export * from './cat21-protocol';

// --- Bitcoin / per-wallet script construction (used by every flow) ---
export * from './cat21-script';

// --- Network primitives ---
export * from './network';

// --- Wallet types (KnownOrdinalWalletType enum and friends; pure) ---
// Public types only. The bypass surface (WalletSigner, signingMap
// types, per-method input types) intentionally NOT re-exported —
// consumers reach Bitcoin operations via the operation-named
// orchestrators (cat21.service, *-orchestrator.service,
// inscribeAndBroadcast). See HARD RULE "signingMap is BANNED" in
// SDK CLAUDE.md.
export {
  KnownOrdinalWalletType,
  KnownOrdinalWallets,
  type KnownOrdinalWallet,
  type WalletInfo,
  type WalletConnector,
  type WindowLike,
  type XverseAddressResponse,
  type LeatherAddressResponse,
  type LeatherAddress,
  type LeatherBtcAddress,
  type LeatherStxAddress,
} from './wallet/wallet.service.types';

// --- Branded Bitcoin address types (compile-time separation of
//     OrdinalsAddress vs PaymentAddress). Belongs at core so any
//     consumer — Angular or plain-Node bot — can opt into the
//     compile-time protection at critical boundaries.
export * from './wallet/address-types';
export * from './wallet/wallet-capabilities';
export * from './wallet/wallet-deeplink';
export * from './wallet/xpub/derive-watch-only';
export * from './wallet/xpub/scan-watch-only';
export * from './wallet/xpub/cats-at-address';
export * from './wallet/xpub/classify-outpoint';
export * from './wallet/xpub/make-watch-only-probe';

// --- CAT-21 mint (PSBT-build helpers; the Angular Cat21Service that
//     orchestrates is at the main entry only). ---
export * from './cat21-mint/cat21.service.helper';
export * from './cat21-mint/cat21.service.types';
export * from './cat21-mint/cat21-mint.helper';
export * from './cat21-mint/cat21-mint-input-adapter';

// --- CAT-21 data API: framework-agnostic fetch twin of the Angular
//     Cat21ApiService (status + latest-cat-numbers), the shared wire
//     types, and the pure URL builders. Consumers own caching/reactivity. ---
export * from './cat21-mint/cat21-api.types';
export * from './cat21-mint/cat21-api.urls';
export * from './cat21-mint/cat21-api.fetch';

// --- UTXO content-safety scanner: pure types + detection primitives.
//     The Angular @Injectable `UtxoContentScanner` service stays in
//     the main entry only; the pure detection primitives (bucketOf,
//     rune-name extraction, thresholds, all type aliases) belong at
//     core so non-Angular consumers — bots, cat21-wallet autonomous
//     flows, CLIs — can reach them. Content-safe funding auto-pick is
//     `selectFunding` (force-scans covering candidates), not a raw
//     bucket helper.
export * from './cat21-mint/utxo-content.types';
export * from './cat21-mint/recommended-funding.helper';
export * from './cat21-mint/sat-rarity.helper';

// --- CAT-21 fee simulation + coin selection (shared across flows) ---
export * from './cat21-fee/fee-simulation.helper';
export * from './cat21-fee/coin-selection.helper';
export * from './cat21-fee/dummy-keypair';
export * from './cat21-fee/compute-psbt-vsize.helper';
export * from './cat21-fee/min-relay-fee';
export * from './cat21-fee/ord-coin-select';
export * from './cat21-fee/funding-safety';

// --- Framework-agnostic orchestration core (ports + async flows; no Angular,
//     no RxJS — the single source of truth all three CAT-21 paths compose) ---
export * from './cat21-core/ports';
export * from './cat21-core/select-funding';
export * from './cat21-core/transfer.core';
export * from './cat21-core/mint.core';
export * from './cat21-core/create-offer.core';
export * from './cat21-core/inscribe.core';
export * from './cat21-core/accept-offer.core';

// --- CAT-21 transfer ---
export * from './cat21-transfer/cat21-transfer.helper';
export * from './cat21-transfer/cat21-transfer.types';
export * from './cat21-transfer/cat21-transfer-input-adapter';

// --- CAT-21 offer (ord-style buy-offer builder + seller validator) ---
export * from './cat21-offer/cat21-offer.helper';
export * from './cat21-offer/cat21-offer.types';
export * from './cat21-offer/cat21-offer-input-adapter';

// --- CAT-21 broadcast (mempool / Slipstream dispatcher) ---
export * from './cat21-broadcast/broadcast.helper';
export * from './cat21-broadcast/slipstream.helper';

// --- CAT-21 share (canonical CatOutpoint type + permalink query
//     builders/parsers for ask, buy, accept-offer, transfer — single
//     source of truth for URL params and outpoint shape across
//     cat21.space, cat21-wallet, and any future consumer). ---
export * from './cat21-share';

// --- CAT-21 listing (public "cat orderbook" listing shape).
//     Historical per-listing BIP-322 helpers (buildListingMessage,
//     verifyListingSignature) are retained for backward compat but
//     are no longer required by the marketplace flow — CREATE listing
//     now authenticates via the session-token layer below, same as
//     DELETE. See workspace CLAUDE.md philosophy: the marketplace
//     layer is convenience; the tamper-proof record is the PSBT +
//     Bitcoin as the ledger. ---
export * from './cat21-listing/cat21-listing.types';
export * from './cat21-listing/build-listing-message';
export * from './cat21-listing/verify-listing-signature';

// --- CAT-21 session-token capability layer. Prompts the user for
//     ONE BIP-322 signature per ~24h; every marketplace mutation
//     (CREATE listing, DELETE listing, DELETE bid, future capability
//     endpoints) reuses the cached session token via headers. NOT
//     used for CREATE bid (PSBT SIGHASH_ALL self-authenticates). ---
export * from './cat21-session/session-message';

// --- BIP-322 verification primitive. Extracted from
//     verify-listing-signature.ts so the session guard + any future
//     capability verifier share exactly one implementation. ---
export * from './wallet/verify-bip322-signature';

// --- Inscribe (commit + reveal pipeline; ord-compatible envelope) ---
export * from './inscribe/inscription-envelope';
export * from './inscribe/inscription-cbor';
export * from './inscribe/inscription-commit.helper';
export * from './inscribe/inscription-reveal.helper';
export * from './inscribe/inscription-child-reveal.helper';
export * from './inscribe/inscription-input-adapter';
export * from './inscribe/inscription-fee.helper';
export * from './inscribe/inscription.service.helper';
export * from './inscribe/inscribe-broadcast.helper';
export * from './inscribe/inscribe-orchestrator';
export * from './inscribe/inscribe-child-orchestrator';
export * from './inscribe/inscribe-compression.helper';

// --- Agent-mode policy gate ---
export * from './agent-mode/agent-policy.helper';
export * from './agent-mode/agent-policy.types';

// --- Bulletproof operation validation gates ---
export * from './cat21-validation';
export * from './inscribe-validation';
