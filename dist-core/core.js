"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnownOrdinalWallets = exports.KnownOrdinalWalletType = void 0;
// --- Protocol-wide constants (postage, lockTime, per-wallet sequence) ---
__exportStar(require("./cat21-protocol"), exports);
// --- Bitcoin / per-wallet script construction (used by every flow) ---
__exportStar(require("./cat21-script"), exports);
// --- Network primitives ---
__exportStar(require("./network"), exports);
// --- Wallet types (KnownOrdinalWalletType enum and friends; pure) ---
// Public types only. The bypass surface (WalletSigner, signingMap
// types, per-method input types) intentionally NOT re-exported —
// consumers reach Bitcoin operations via the operation-named
// orchestrators (cat21.service, *-orchestrator.service,
// inscribeAndBroadcast). See HARD RULE "signingMap is BANNED" in
// SDK CLAUDE.md.
var wallet_service_types_1 = require("./wallet/wallet.service.types");
Object.defineProperty(exports, "KnownOrdinalWalletType", { enumerable: true, get: function () { return wallet_service_types_1.KnownOrdinalWalletType; } });
Object.defineProperty(exports, "KnownOrdinalWallets", { enumerable: true, get: function () { return wallet_service_types_1.KnownOrdinalWallets; } });
// --- CAT-21 mint (PSBT-build helpers; the Angular Cat21Service that
//     orchestrates is at the main entry only). ---
__exportStar(require("./cat21-mint/cat21.service.helper"), exports);
__exportStar(require("./cat21-mint/cat21.service.types"), exports);
__exportStar(require("./cat21-mint/cat21-mint.helper"), exports);
__exportStar(require("./cat21-mint/cat21-mint-input-adapter"), exports);
// --- CAT-21 fee simulation + coin selection (shared across flows) ---
__exportStar(require("./cat21-fee/fee-simulation.helper"), exports);
__exportStar(require("./cat21-fee/coin-selection.helper"), exports);
__exportStar(require("./cat21-fee/dummy-keypair"), exports);
// --- CAT-21 transfer ---
__exportStar(require("./cat21-transfer/cat21-transfer.helper"), exports);
__exportStar(require("./cat21-transfer/cat21-transfer.types"), exports);
__exportStar(require("./cat21-transfer/cat21-transfer-input-adapter"), exports);
// --- CAT-21 offer (ord-style buy-offer builder + seller validator) ---
__exportStar(require("./cat21-offer/cat21-offer.helper"), exports);
__exportStar(require("./cat21-offer/cat21-offer.types"), exports);
__exportStar(require("./cat21-offer/cat21-offer-input-adapter"), exports);
// --- CAT-21 broadcast (mempool / Slipstream dispatcher) ---
__exportStar(require("./cat21-broadcast/broadcast.helper"), exports);
__exportStar(require("./cat21-broadcast/slipstream.helper"), exports);
// --- Inscribe (commit + reveal pipeline; ord-compatible envelope) ---
__exportStar(require("./inscribe/inscription-envelope"), exports);
__exportStar(require("./inscribe/inscription-commit.helper"), exports);
__exportStar(require("./inscribe/inscription-reveal.helper"), exports);
__exportStar(require("./inscribe/inscription-input-adapter"), exports);
__exportStar(require("./inscribe/inscription-fee.helper"), exports);
__exportStar(require("./inscribe/inscription.service.helper"), exports);
__exportStar(require("./inscribe/inscribe-broadcast.helper"), exports);
__exportStar(require("./inscribe/inscribe-orchestrator"), exports);
// --- Agent-mode policy gate ---
__exportStar(require("./agent-mode/agent-policy.helper"), exports);
__exportStar(require("./agent-mode/agent-policy.types"), exports);
// --- Bulletproof operation validation gates ---
__exportStar(require("./cat21-validation"), exports);
__exportStar(require("./inscribe-validation"), exports);
//# sourceMappingURL=core.js.map