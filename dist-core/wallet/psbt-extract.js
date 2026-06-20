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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractWireTxFromPsbt = extractWireTxFromPsbt;
exports.broadcastSignedPsbt = broadcastSignedPsbt;
const btc = __importStar(require("@scure/btc-signer"));
const rxjs_1 = require("rxjs");
/**
 * Finalize a signed PSBT (if needed) and extract the wire-format
 * raw transaction hex.
 *
 * Used by every wallet signer in `src/wallet/signers/` and by the
 * Pipeline B harness in `e2e/playwright/fixtures/`. Encodes the
 * SDK-wide "WE finalize, WE broadcast" convention (see
 * `/Work/ordpool/WALLETS.md`):
 *
 *  1. Wallets sign and hand back a PSBT (preferably with partial
 *     sigs, where the wallet API exposes a "don't finalize" option).
 *  2. `@scure/btc-signer.finalize()` combines partial sigs into
 *     `finalScriptWitness`. Some wallets always finalize themselves
 *     (Leather v6.x has no opt-out, Unisat with `autoFinalized:true`)
 *     — finalize() throws "Not enough partial sign" in that case;
 *     safe to ignore because the wallet's pre-populated witness is
 *     already in place. Re-throw anything else.
 *  3. `extract()` produces the wire-format bytes; we serialise to hex.
 */
function extractWireTxFromPsbt(signedPsbtBytes) {
    const tx = btc.Transaction.fromPSBT(signedPsbtBytes);
    try {
        tx.finalize();
    }
    catch (e) {
        if (!/Not enough partial sign/i.test(e.message))
            throw e;
    }
    return tx.hex;
}
/**
 * Final 3 steps of every wallet signer's `signAndBroadcast`:
 * extract wire-tx hex from the wallet's signed PSBT, hand it to
 * the caller-supplied broadcast callback, wrap the resulting
 * txid in the `{ txId }` shape.
 *
 * Pins the "WE broadcast" convention: the broadcast endpoint is
 * the SDK's call, not the wallet's vendor backend. All three
 * production signers + the Pipeline B harness route through here.
 */
function broadcastSignedPsbt(input, signedPsbtBytes) {
    const txHex = extractWireTxFromPsbt(signedPsbtBytes);
    return input.broadcast(txHex).pipe((0, rxjs_1.map)(txId => ({ txId })));
}
//# sourceMappingURL=psbt-extract.js.map