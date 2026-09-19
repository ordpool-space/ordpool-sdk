// ordpool-sdk public API surface.

// --- shared abstractions ---
export * from './cat21-protocol/index.js';
export * from './cat21-script/index.js';
export * from './storage-like.js';
export * from './network.js';

// --- wallet (Xverse / Leather / Unisat picker + connect flow) ---
export * from './wallet/wallet.service.js';
// Public types only — see core.ts for the rationale.
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
  type SignMessageArgs,
  type SignMessageResult,
} from './wallet/wallet.service.types.js';
export { KnownOrdinalWallets } from './wallet/known-ordinal-wallets.js';
// Branded Bitcoin address types — see core.ts for the rationale.
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
export * from './wallet/wallet-picker.js';
export * from './wallet/wallet-deeplink.js';
export * from './wallet/xpub/derive-watch-only.js';
export * from './wallet/xpub/scan-watch-only.js';
export * from './wallet/xpub/cats-at-address.js';
export * from './wallet/xpub/classify-outpoint.js';
export * from './wallet/xpub/make-watch-only-probe.js';

// --- cat21 mint pipeline (PSBT builder, simulator, broadcaster) ---
export * from './cat21-mint/cat21-sdk-config.js';
export * from './cat21-mint/cat21.service.js';
export * from './cat21-mint/cat21.service.helper.js';
export * from './cat21-mint/cat21.service.types.js';
export * from './cat21-mint/cat21-api.service.js';
// Framework-agnostic orchestrators (plain classes, subscribe-based) are the
// only Bitcoin-operation surface — the same ones as the /core entry.
export * from './cat21-mint/cat21-mint-orchestrator.js';
export * from './cat21-mint/cat21-mint-input-adapter.js';
export * from './cat21-mint/utxo-content.types.js';
// Canonical /output fixtures, so a consumer's mock cannot drift from the
// classifier contract. Test-only in practice; exported because the consumers
// that need them are separate repos.
export * from './cat21-mint/utxo-content.fixtures.js';
export * from './cat21-mint/recommended-fees.fixtures.js';
export * from './cat21-mint/rune-etching.js';
export * from './cat21-mint/rune-amount.js';
export * from './cat21-mint/recommended-funding.helper.js';
export * from './cat21-mint/utxo-content-scanner.service.js';
export * from './cat21-mint/sat-rarity.helper.js';

// --- cat21 fee simulation + coin selection (Layer 3, shared) ---
export * from './cat21-fee/coin-selection.helper.js';
export * from './cat21-fee/dummy-keypair.js';
export * from './cat21-fee/min-relay-fee.js';
export * from './cat21-fee/ord-coin-select.js';
export * from './cat21-fee/funding-safety.js';
export * from './cat21-fee/candidate-fees.js';
export * from './wallet/wallet-identity.js';
export * from './cat21-fee/funding-recommendation.service.js';

// --- Framework-agnostic orchestration core (ports + async flows) ---
export * from './cat21-core/ports.js';
export * from './cat21-core/select-funding.js';
export * from './cat21-core/dedupe-utxos.js';
export * from './cat21-core/transfer.core.js';
export * from './cat21-core/mint.core.js';
export * from './cat21-core/create-offer.core.js';
export * from './cat21-core/inscribe.core.js';
export * from './cat21-core/accept-offer.core.js';

// --- cat21 offer (ord-style buyer-initiated PSBT builder + seller-side validator) ---
export * from './cat21-offer/cat21-offer.helper.js';
export * from './cat21-offer/cat21-offer.types.js';
export * from './cat21-offer/cat21-offer-input-adapter.js';
export * from './cat21-offer/cat21-create-offer-orchestrator.js';
export * from './cat21-offer/cat21-accept-offer-orchestrator.js';
export * from './cat21-offer/decode-pasted-psbt.js';

// --- cat21 transfer (move a cat to another address; mints a fresh cat on the same ordinal) ---
export * from './cat21-transfer/cat21-transfer.helper.js';
export * from './cat21-transfer/cat21-transfer.types.js';
export * from './cat21-transfer/cat21-transfer-input-adapter.js';
export * from './cat21-transfer/cat21-transfer-orchestrator.js';

// --- cat21 broadcast (mempool / Slipstream dispatcher + Slipstream client) ---
export * from './cat21-broadcast/broadcast.helper.js';
export * from './cat21-broadcast/slipstream.helper.js';

// --- cat21 share (canonical CatOutpoint type + permalink query
//     builders/parsers — single source of truth for URL params and
//     outpoint shape). ---
export * from './cat21-share/index.js';

// --- cat21 listing (public "cat orderbook" listing shape). Historical
//     per-listing BIP-322 helpers are retained; the CREATE listing
//     flow now authenticates via the session-token layer below. ---
export * from './cat21-listing/cat21-listing.types.js';
export * from './cat21-listing/build-listing-message.js';
export * from './cat21-listing/verify-listing-signature.js';

// --- CAT-21 session-token capability layer (BIP-322-authed session
//     for marketplace mutations). ---
export * from './cat21-session/session-message.js';
export * from './wallet/verify-bip322-signature.js';

// --- inscribe (commit + reveal pipeline; ord-compatible envelope) ---
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
export * from './inscribe/inscribe-child-orchestrator.js';
export * from './inscribe/inscribe-mint-orchestrator.js';
export * from './inscribe/inscribe-compression.helper.js';
export * from './inscribe/brotli-wasm-encoder.js';

// --- inscribe validation gate (pure helpers, same set that /core exposes) ---
export * from './inscribe-validation/index.js';

// --- agent-mode (autonomous-action policy gate) ---
export * from './agent-mode/agent-policy.helper.js';
export * from './agent-mode/agent-policy.types.js';
