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

// --- Network primitives ---
export * from './network';

// --- Wallet types (KnownOrdinalWalletType enum and friends; pure) ---
export * from './wallet/wallet.service.types';

// --- CAT-21 mint (PSBT-build helpers; the Angular Cat21Service that
//     orchestrates is at the main entry only). ---
export * from './cat21-mint/cat21.service.helper';
export * from './cat21-mint/cat21.service.types';

// --- CAT-21 transfer ---
export * from './cat21-transfer/cat21-transfer.helper';
export * from './cat21-transfer/cat21-transfer.types';

// --- CAT-21 offer (ord-style buy-offer builder + seller validator) ---
export * from './cat21-offer/cat21-offer.helper';
export * from './cat21-offer/cat21-offer.types';

// --- CAT-21 broadcast (mempool / Slipstream dispatcher) ---
export * from './cat21-broadcast/broadcast.helper';
export * from './cat21-broadcast/slipstream.helper';

// --- Agent-mode policy gate ---
export * from './agent-mode/agent-policy.helper';
export * from './agent-mode/agent-policy.types';
