/**
 * `ordpool-sdk/core` — the lean entry point (`dist/core.js`).
 *
 * Re-exports the pure helpers, constants, types and the subscribe-based
 * orchestrators. The cat21-wallet extension, CLIs, GitHub Actions and any
 * plain Node service import from here:
 *
 *     import { buildCat21TransferPsbt } from 'ordpool-sdk/core';
 *
 * The main entry point (`ordpool-sdk`, ESM `dist`) re-exports everything in
 * this file PLUS the stateful, `Observable`-returning service classes
 * (`WalletService`, `Cat21Service`, `Cat21ApiService`, `UtxoContentScanner`)
 * that the frontends compose. Everything in the whole SDK is framework-
 * agnostic; the two entries differ only by module format (CJS vs ESM) and by
 * whether the stateful classes are included.
 *
 * Convention: when adding a new pure helper, export it from its own file AND
 * add a re-export here AND add the file to `tsconfig.core.json`'s `include`
 * list (its build is include-only, not graph-following). The architecture
 * spec in the cat21-wallet repo
 * (apps/extension/src/__architecture__/architecture.spec.ts) pins that all
 * wallet imports of SDK symbols go through `'ordpool-sdk/core'`, never
 * through bare `'ordpool-sdk'`.
 */

// --- Protocol-wide constants (postage, lockTime, per-wallet sequence) ---
export * from './cat21-protocol/index.js';

// --- Bitcoin / per-wallet script construction (used by every flow) ---
export * from './cat21-script/index.js';

// --- Network primitives ---
export * from './network.js';

// --- Wallet types (KnownOrdinalWalletType enum and friends; pure) ---
// Public types only. The bypass surface (WalletSigner, signingMap
// types, per-method input types) intentionally NOT re-exported —
// consumers reach Bitcoin operations via the operation-named
// orchestrators (cat21.service, *-orchestrator.service,
// inscribeAndBroadcast). See HARD RULE "signingMap is BANNED" in
// SDK CLAUDE.md.
export {
  KnownOrdinalWalletType,
  type KnownOrdinalWallet,
  type WalletInfo,
  type WalletConnector,
  type WindowLike,
  type XverseAddressResponse,
  type LeatherAddressResponse,
  type LeatherAddress,
  type LeatherBtcAddress,
  type LeatherStxAddress,
} from './wallet/wallet.service.types.js';
export { KnownOrdinalWallets } from './wallet/known-ordinal-wallets.js';

// --- Branded Bitcoin address types (compile-time separation of
//     OrdinalsAddress vs PaymentAddress). Belongs at core so any
//     consumer — a frontend or a plain-Node bot — can opt into the
//     compile-time protection at critical boundaries.
export * from './wallet/address-types.js';
export * from './format/mempool-format.js';
export * from './wallet/connect-ui.js';
export * from './inscribe/inscription-properties.js';
export * from './inscribe/inscription-batch.helper.js';
export * from './inscribe/sat-offset.js';
export * from './inscribe/inscription-existence.js';
export * from './inscribe/sat-picker.js';
export * from './inscribe/padding-utxo.js';
export * from './inscribe/parent-resolve.js';
export * from './inscribe/taproot-owned-input.js';
export * from './inscribe/inscribe-errors.js';
export * from './inscribe/inscription-json-metadata.js';
export * from './family/coin-check-promise.js';
export * from './family/ordpool-family.js';
export * from './wallet/wallet-capabilities.js';
export * from './wallet/wallet-deeplink.js';
export * from './wallet/xpub/derive-watch-only.js';
export * from './wallet/xpub/scan-watch-only.js';
export * from './wallet/xpub/cats-at-address.js';
export * from './wallet/xpub/classify-outpoint.js';
export * from './wallet/xpub/make-watch-only-probe.js';

// --- CAT-21 mint (PSBT-build helpers; the stateful Cat21Service is at the
//     main entry only). ---
export * from './cat21-mint/cat21.service.helper.js';
export * from './cat21-mint/cat21.service.types.js';
export * from './cat21-mint/cat21-mint.helper.js';
export * from './cat21-mint/cat21-mint-input-adapter.js';

// --- CAT-21 mint orchestrator (subscribe-based high-level API). ---
export * from './cat21-mint/cat21-mint-orchestrator.js';

// --- CAT-21 data API: the fetch twin of the Observable-returning
//     Cat21ApiService (status + latest-cat-numbers), the shared wire
//     types, and the pure URL builders. Consumers own caching/reactivity. ---
export * from './cat21-mint/cat21-api.types.js';
export * from './cat21-mint/cat21-api.urls.js';
export * from './cat21-mint/cat21-api.fetch.js';

// --- UTXO content-safety scanner: pure types + detection primitives.
//     The stateful `UtxoContentScanner` class stays in the main entry
//     only; the pure detection primitives (bucketOf, rune-name
//     extraction, thresholds, all type aliases) belong at core so
//     bots, cat21-wallet autonomous flows and CLIs can reach them.
//     Content-safe funding auto-pick is `selectFunding` (force-scans
//     covering candidates), not a raw bucket helper.
export * from './cat21-mint/utxo-content.types.js';
// Canonical /output fixtures, so a consumer's mock cannot drift from the
// classifier contract. Test-only in practice; exported because the consumers
// that need them are separate repos.
export * from './cat21-mint/utxo-content.fixtures.js';
export * from './cat21-mint/rune-etching.js';
export * from './cat21-mint/rune-amount.js';
export * from './cat21-mint/recommended-funding.helper.js';
export * from './cat21-mint/sat-rarity.helper.js';

// --- CAT-21 fee simulation + coin selection (shared across flows) ---
export * from './cat21-fee/coin-selection.helper.js';
export * from './cat21-fee/dummy-keypair.js';
export * from './cat21-fee/compute-psbt-vsize.helper.js';
export * from './cat21-fee/min-relay-fee.js';
export * from './cat21-fee/ord-coin-select.js';
export * from './cat21-fee/funding-safety.js';

// --- Orchestration core (ports + async flows; no RxJS — the single source
//     of truth all three CAT-21 paths compose) ---
export * from './cat21-core/ports.js';
export * from './cat21-core/select-funding.js';
export * from './cat21-core/dedupe-utxos.js';
export * from './cat21-core/transfer.core.js';
export * from './cat21-core/mint.core.js';
export * from './cat21-core/create-offer.core.js';
export * from './cat21-core/inscribe.core.js';
export * from './cat21-core/accept-offer.core.js';

// --- CAT-21 transfer ---
export * from './cat21-transfer/cat21-transfer.helper.js';
export * from './cat21-transfer/cat21-transfer.types.js';
export * from './cat21-transfer/cat21-transfer-input-adapter.js';

// --- CAT-21 transfer framework-agnostic orchestrator (subscribe-based). ---
export * from './cat21-transfer/cat21-transfer-orchestrator.js';

// --- CAT-21 offer (ord-style buy-offer builder + seller validator) ---
export * from './cat21-offer/cat21-offer.helper.js';
export * from './cat21-offer/cat21-offer.types.js';
export * from './cat21-offer/cat21-offer-input-adapter.js';

// --- CAT-21 create-offer framework-agnostic orchestrator (subscribe-based). ---
export * from './cat21-offer/cat21-create-offer-orchestrator.js';

// --- CAT-21 accept-offer framework-agnostic orchestrator (subscribe-based). ---
export * from './cat21-offer/decode-pasted-psbt.js';
export * from './cat21-offer/cat21-accept-offer-orchestrator.js';

// --- CAT-21 broadcast (mempool / Slipstream dispatcher) ---
export * from './cat21-broadcast/broadcast.helper.js';
export * from './cat21-broadcast/slipstream.helper.js';

// --- CAT-21 share (canonical CatOutpoint type + permalink query
//     builders/parsers for ask, buy, accept-offer, transfer — single
//     source of truth for URL params and outpoint shape across
//     cat21.space, cat21-wallet, and any future consumer). ---
export * from './cat21-share/index.js';

// --- CAT-21 listing (public "cat orderbook" listing shape).
//     Historical per-listing BIP-322 helpers (buildListingMessage,
//     verifyListingSignature) are retained for backward compat but
//     are no longer required by the marketplace flow — CREATE listing
//     now authenticates via the session-token layer below, same as
//     DELETE. See workspace CLAUDE.md philosophy: the marketplace
//     layer is convenience; the tamper-proof record is the PSBT +
//     Bitcoin as the ledger. ---
export * from './cat21-listing/cat21-listing.types.js';
export * from './cat21-listing/build-listing-message.js';
export * from './cat21-listing/verify-listing-signature.js';

// --- CAT-21 session-token capability layer. Prompts the user for
//     ONE BIP-322 signature per ~24h; every marketplace mutation
//     (CREATE listing, DELETE listing, DELETE bid, future capability
//     endpoints) reuses the cached session token via headers. NOT
//     used for CREATE bid (PSBT SIGHASH_ALL self-authenticates). ---
export * from './cat21-session/session-message.js';

// --- BIP-322 verification primitive. Extracted from
//     verify-listing-signature.ts so the session guard + any future
//     capability verifier share exactly one implementation. ---
export * from './wallet/verify-bip322-signature.js';

// --- Inscribe (commit + reveal pipeline; ord-compatible envelope) ---
export * from './inscribe/inscription-envelope.js';
export * from './inscribe/inscription-cbor.js';
export * from './inscribe/inscription-commit.helper.js';
export * from './inscribe/inscription-reveal.helper.js';
export * from './inscribe/inscription-child-reveal.helper.js';
export * from './inscribe/inscription-input-adapter.js';
export * from './inscribe/inscription-fee.helper.js';
export * from './inscribe/inscription.service.helper.js';
export * from './inscribe/inscribe-broadcast.helper.js';
export * from './inscribe/inscribe-orchestrator.js';
// --- inscribe framework-agnostic mint orchestrator (subscribe-based). ---
export * from './inscribe/inscribe-mint-orchestrator.js';
export * from './inscribe/inscribe-child-orchestrator.js';
export * from './inscribe/inscribe-compression.helper.js';
export * from './inscribe/brotli-wasm-encoder.js';

// --- Agent-mode policy gate ---
export * from './agent-mode/agent-policy.helper.js';
export * from './agent-mode/agent-policy.types.js';

// --- Bulletproof operation validation gates ---
export * from './cat21-validation/index.js';
export * from './inscribe-validation/index.js';
