"use strict";
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
/**
 * Bitcoin / per-wallet script construction helpers, used across the
 * CAT-21 pipeline. No flow-specific code lives here — every consumer
 * (mint, transfer, offer) and the cat21.space orchestrator all reach
 * into this folder for address-format detection + per-wallet script
 * assembly.
 */
__exportStar(require("./address-format"), exports);
__exportStar(require("./build-input-script"), exports);
//# sourceMappingURL=index.js.map