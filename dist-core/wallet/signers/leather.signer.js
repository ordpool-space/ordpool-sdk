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
exports.leatherSigner = void 0;
const base_1 = require("@scure/base");
const btc = __importStar(require("@scure/btc-signer"));
const rxjs_1 = require("rxjs");
const network_1 = require("../../network");
const psbt_extract_1 = require("../psbt-extract");
const wallet_service_types_1 = require("../wallet.service.types");
const operation_named_defaults_1 = require("./operation-named-defaults");
const signing_targets_helper_1 = require("./signing-targets.helper");
/**
 * Leather — `window.LeatherProvider.request('signPsbt', …)`.
 *
 * Leather signs and hands the signed PSBT back to us; broadcasting
 * is our job. The signed PSBT is finalised via @scure/btc-signer,
 * then we delegate the broadcast to the caller's `broadcast`
 * callback (which hits electrs `POST /tx` via the configured
 * HttpClient).
 *
 * Namespace: `window.LeatherProvider`, NOT the historical
 * `window.btc`. The `window.btc` global is the old Hiro namespace
 * that other extensions (Unisat in some versions) have aggressively
 * overwritten; users with multiple wallet extensions installed have
 * hit our code routing to the wrong wallet. See the multi-injection
 * section of PLAN-wallet-roster.md.
 *
 * Multi-input signing: Leather's signPsbt takes a single
 * `signAtIndex`. For flows that need multiple inputs signed the
 * multi method iterates the flat index list, threading the
 * partially-signed PSBT hex through each call. Same pattern as
 * cat21-wallet (which is a Leather fork). Each call surfaces a
 * confirmation dialog in the wallet.
 */
function callLeatherSignPsbt(psbtHex, signAtIndex, network) {
    const win = window;
    const params = {
        hex: psbtHex,
        allowedSighash: [btc.SigHash.ALL],
        signAtIndex,
        network,
        broadcast: false,
    };
    return win.LeatherProvider.request('signPsbt', params).then((resp) => resp.result.hex);
}
const legacy = {
    signAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const network = (0, network_1.toLeatherNetworkString)(input.network);
        return (0, rxjs_1.defer)(() => (0, rxjs_1.from)(callLeatherSignPsbt(psbtHex, 0, network))).pipe((0, rxjs_1.switchMap)((signedHex) => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.hex.decode(signedHex))));
    },
    signMultiInputAndBroadcast(input) {
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const flatIndexes = [];
        for (const t of targets) {
            for (const i of t.indexes)
                flatIndexes.push(i);
        }
        const network = (0, network_1.toLeatherNetworkString)(input.network);
        return (0, rxjs_1.defer)(() => {
            let chain = Promise.resolve(base_1.hex.encode(input.psbtBytes));
            for (const i of flatIndexes) {
                chain = chain.then((currentHex) => callLeatherSignPsbt(currentHex, i, network));
            }
            return (0, rxjs_1.from)(chain);
        }).pipe((0, rxjs_1.switchMap)((finalHex) => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.hex.decode(finalHex))));
    },
    signPsbtOnly(input) {
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const flatIndexes = [];
        for (const t of targets) {
            for (const i of t.indexes)
                flatIndexes.push(i);
        }
        const network = (0, network_1.toLeatherNetworkString)(input.network);
        return (0, rxjs_1.defer)(() => {
            let chain = Promise.resolve(base_1.hex.encode(input.psbtBytes));
            for (const i of flatIndexes) {
                chain = chain.then((currentHex) => callLeatherSignPsbt(currentHex, i, network));
            }
            return (0, rxjs_1.from)(chain);
        }).pipe((0, rxjs_1.map)((finalHex) => base_1.hex.decode(finalHex)));
    },
};
exports.leatherSigner = {
    providerId: wallet_service_types_1.KnownOrdinalWalletType.leather,
    ...(0, operation_named_defaults_1.operationNamedDefaults)(legacy),
};
//# sourceMappingURL=leather.signer.js.map