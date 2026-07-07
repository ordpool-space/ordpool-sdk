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

// --- CAT-21 mint (PSBT-build helpers; the Angular Cat21Service that
//     orchestrates is at the main entry only). ---
export * from './cat21-mint/cat21.service.helper';
export * from './cat21-mint/cat21.service.types';
export * from './cat21-mint/cat21-mint.helper';
export * from './cat21-mint/cat21-mint-input-adapter';

// --- CAT-21 fee simulation + coin selection (shared across flows) ---
export * from './cat21-fee/fee-simulation.helper';
export * from './cat21-fee/coin-selection.helper';
export * from './cat21-fee/dummy-keypair';

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

// --- CAT-21 share (permalink query builders + parsers for ask, buy,
//     accept-offer, transfer — single source of truth for URL params
//     across cat21.space, cat21-wallet, and any future consumer). ---
export * from './cat21-share/permalink.helper';

// --- Inscribe (commit + reveal pipeline; ord-compatible envelope) ---
export * from './inscribe/inscription-envelope';
export * from './inscribe/inscription-commit.helper';
export * from './inscribe/inscription-reveal.helper';
export * from './inscribe/inscription-input-adapter';
export * from './inscribe/inscription-fee.helper';
export * from './inscribe/inscription.service.helper';
export * from './inscribe/inscribe-broadcast.helper';
export * from './inscribe/inscribe-orchestrator';
export * from './inscribe/inscribe-brotli.helper';

// --- Agent-mode policy gate ---
export * from './agent-mode/agent-policy.helper';
export * from './agent-mode/agent-policy.types';

// --- Bulletproof operation validation gates ---
export * from './cat21-validation';
export * from './inscribe-validation';
