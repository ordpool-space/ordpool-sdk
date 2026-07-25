// ordpool-sdk public API surface.

// --- shared abstractions ---
export * from './cat21-protocol';
export * from './cat21-script';
export * from './storage-like';
export * from './network';
export * from './network-token';

// --- wallet (Xverse / Leather / Unisat picker + connect flow) ---
export * from './wallet/wallet.service';
// Public types only — see core.ts for the rationale.
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
  type SignMessageArgs,
  type SignMessageResult,
} from './wallet/wallet.service.types';
// Branded Bitcoin address types — see core.ts for the rationale.
export * from './wallet/address-types';

// --- cat21 mint pipeline (PSBT builder, simulator, broadcaster) ---
export * from './cat21-mint/cat21-sdk-config';
export * from './cat21-mint/cat21.service';
export * from './cat21-mint/cat21.service.helper';
export * from './cat21-mint/cat21.service.types';
export * from './cat21-mint/cat21-api.service';
export * from './cat21-mint/cat21-mint-orchestrator.service';
export * from './cat21-mint/cat21-mint-input-adapter';
export * from './cat21-mint/utxo-content.types';
export * from './cat21-mint/utxo-content-scanner.service';
export * from './cat21-mint/sat-rarity.helper';

// --- cat21 fee simulation + coin selection (Layer 3, shared) ---
export * from './cat21-fee/fee-simulation.helper';
export * from './cat21-fee/coin-selection.helper';
export * from './cat21-fee/dummy-keypair';

// --- cat21 offer (ord-style buyer-initiated PSBT builder + seller-side validator) ---
export * from './cat21-offer/cat21-offer.helper';
export * from './cat21-offer/cat21-offer.types';
export * from './cat21-offer/cat21-offer-input-adapter';
export * from './cat21-offer/cat21-create-offer-orchestrator.service';
export * from './cat21-offer/cat21-accept-offer-orchestrator.service';

// --- cat21 transfer (move a cat to another address; mints a fresh cat on the same ordinal) ---
export * from './cat21-transfer/cat21-transfer.helper';
export * from './cat21-transfer/cat21-transfer.types';
export * from './cat21-transfer/cat21-transfer-input-adapter';
export * from './cat21-transfer/cat21-transfer-orchestrator.service';

// --- cat21 broadcast (mempool / Slipstream dispatcher + Slipstream client) ---
export * from './cat21-broadcast/broadcast.helper';
export * from './cat21-broadcast/slipstream.helper';

// --- cat21 share (canonical CatOutpoint type + permalink query
//     builders/parsers — single source of truth for URL params and
//     outpoint shape). ---
export * from './cat21-share';

// --- cat21 listing (public "cat orderbook" listing shape). Historical
//     per-listing BIP-322 helpers are retained; the CREATE listing
//     flow now authenticates via the session-token layer below. ---
export * from './cat21-listing/cat21-listing.types';
export * from './cat21-listing/build-listing-message';
export * from './cat21-listing/verify-listing-signature';

// --- CAT-21 session-token capability layer (BIP-322-authed session
//     for marketplace mutations). ---
export * from './cat21-session/session-message';
export * from './wallet/verify-bip322-signature';

// --- inscribe (commit + reveal pipeline; ord-compatible envelope) ---
export * from './inscribe/inscription-envelope';
export * from './inscribe/inscription-commit.helper';
export * from './inscribe/inscription-reveal.helper';
export * from './inscribe/inscription-input-adapter';
export * from './inscribe/inscription-fee.helper';
export * from './inscribe/inscription.service.helper';
export * from './inscribe/inscribe-broadcast.helper';
export * from './inscribe/inscribe-orchestrator';
export * from './inscribe/inscribe-mint-orchestrator.service';
export * from './inscribe/inscribe-brotli.helper';

// --- agent-mode (autonomous-action policy gate) ---
export * from './agent-mode/agent-policy.helper';
export * from './agent-mode/agent-policy.types';
