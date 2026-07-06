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
exports.cat21walletSigner = void 0;
const base_1 = require("@scure/base");
const btc = __importStar(require("@scure/btc-signer"));
const rxjs_1 = require("rxjs");
const network_1 = require("../../network");
const psbt_extract_1 = require("../psbt-extract");
const wallet_service_helper_1 = require("../wallet.service.helper");
const wallet_service_types_1 = require("../wallet.service.types");
const operation_named_defaults_1 = require("./operation-named-defaults");
const signing_targets_helper_1 = require("./signing-targets.helper");
/**
 * CAT-21 wallet — `window.Cat21Provider.request('signPsbt', …)`.
 *
 * CAT-21 wallet is forked from Leather and inherits Leather's
 * Bitcoin signPsbt JSON-RPC shape verbatim. The wallet signs the
 * PSBT, hands the signed bytes back, and broadcasting is our job
 * via `input.broadcast(...)` (electrs `POST /tx`).
 *
 * Network mapping uses Leather's network strings even though
 * CAT-21 wallet is mainnet-only per its ADR-7 (Stacks/Lightning/
 * testnet UI hidden). The string is still in the request envelope
 * so the wallet's internal validators get what they expect.
 *
 * sighash whitelist is `[SigHash.ALL]` — same as Leather, same as
 * the rest of the SDK's cat-flow path.
 *
 * Multi-input signing: the wallet's `signPsbt` JSON-RPC accepts
 * `signAtIndex` as EITHER a single number or an array. Prefer the
 * array form for multi-input flows (transfer, offer-accept) — the
 * wallet then signs every listed index inside ONE approval popup
 * (see `apps/extension/src/background/messaging/rpc-methods/sign-psbt.ts`
 * → ensureArray). The previous per-index chain fired one popup per
 * signature which cat21-wallet couldn't route reliably: after the
 * first popup closed, subsequent calls hung silently.
 */
function callCat21WalletSignPsbt(psbtHex, signAtIndex, network) {
    const provider = (0, wallet_service_helper_1.findCat21WalletProvider)(window);
    if (!provider) {
        throw new Error('CAT-21 wallet provider not present (window.Cat21Provider undefined or missing isCat21:true marker)');
    }
    const params = {
        hex: psbtHex,
        allowedSighash: [btc.SigHash.ALL],
        signAtIndex,
        network,
        broadcast: false,
    };
    return provider.request('signPsbt', params)
        .then((resp) => resp.result.hex);
}
const legacy = {
    signAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const network = (0, network_1.toLeatherNetworkString)(input.network);
        return (0, rxjs_1.defer)(() => (0, rxjs_1.from)(callCat21WalletSignPsbt(psbtHex, 0, network))).pipe((0, rxjs_1.switchMap)((signedHex) => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.hex.decode(signedHex))));
    },
    signMultiInputAndBroadcast(input) {
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const flatIndexes = [];
        for (const t of targets) {
            for (const i of t.indexes)
                flatIndexes.push(i);
        }
        const network = (0, network_1.toLeatherNetworkString)(input.network);
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        return (0, rxjs_1.defer)(() => (0, rxjs_1.from)(callCat21WalletSignPsbt(psbtHex, flatIndexes, network))).pipe((0, rxjs_1.switchMap)((finalHex) => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.hex.decode(finalHex))));
    },
    signPsbtOnly(input) {
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const flatIndexes = [];
        for (const t of targets) {
            for (const i of t.indexes)
                flatIndexes.push(i);
        }
        const network = (0, network_1.toLeatherNetworkString)(input.network);
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        return (0, rxjs_1.defer)(() => (0, rxjs_1.from)(callCat21WalletSignPsbt(psbtHex, flatIndexes, network))).pipe((0, rxjs_1.map)((finalHex) => base_1.hex.decode(finalHex)));
    },
};
exports.cat21walletSigner = {
    providerId: wallet_service_types_1.KnownOrdinalWalletType.cat21wallet,
    ...(0, operation_named_defaults_1.operationNamedDefaults)(legacy),
};
//# sourceMappingURL=cat21wallet.signer.js.map