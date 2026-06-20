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
exports.xverseSigner = void 0;
const base_1 = require("@scure/base");
const btc = __importStar(require("@scure/btc-signer"));
const rxjs_1 = require("rxjs");
const sats_connect_1 = require("sats-connect");
const network_1 = require("../../network");
const psbt_extract_1 = require("../psbt-extract");
const wallet_service_types_1 = require("../wallet.service.types");
const operation_named_defaults_1 = require("./operation-named-defaults");
const signing_targets_helper_1 = require("./signing-targets.helper");
/**
 * Xverse — sats-connect v4 `signTransaction` (callback-style).
 *
 * Per the SDK-wide "WE broadcast" convention (see
 * `/Work/ordpool/WALLETS.md`): we ask Xverse to sign only
 * (`broadcast: false`), extract the wire-format tx ourselves, and
 * hand it to `input.broadcast(rawTxHex)`. The caller's broadcast
 * callback decides the endpoint — electrs, api.ordpool.space, or
 * a future non-standard-relay path. NEVER mempool.space (host-banned,
 * see workspace `CLAUDE.md`).
 *
 * Migration to sats-connect v3+ `provider.request('signPsbt', ...)`
 * is a separate stream.
 */
function callXverseSignTransaction(psbtBytes, inputsToSign, network, message) {
    const psbtBase64 = base_1.base64.encode(psbtBytes);
    return new rxjs_1.Observable((observer) => {
        (0, sats_connect_1.signTransaction)({
            payload: {
                network: { type: network },
                message,
                psbtBase64,
                broadcast: false,
                inputsToSign,
            },
            onFinish: (response) => {
                const signed = response.psbtBase64;
                if (!signed) {
                    observer.error(new Error('Xverse signTransaction returned without psbtBase64'));
                    return;
                }
                observer.next(signed);
                observer.complete();
            },
            onCancel: () => observer.error(new Error('Request was cancelled')),
        });
    });
}
const legacy = {
    signAndBroadcast(input) {
        const networkType = (0, network_1.toBitcoinNetworkType)(input.network);
        return callXverseSignTransaction(input.psbtBytes, [{ address: input.paymentAddress, signingIndexes: [0], sigHash: btc.SigHash.ALL }], networkType, 'Sign Transaction (CAT-21 Mint)').pipe((0, rxjs_1.switchMap)((signedPsbtBase64) => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.base64.decode(signedPsbtBase64))));
    },
    signMultiInputAndBroadcast(input) {
        const networkType = (0, network_1.toBitcoinNetworkType)(input.network);
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const inputsToSign = targets.map((t) => ({
            address: t.address,
            signingIndexes: t.indexes,
            sigHash: t.sigHash,
        }));
        return callXverseSignTransaction(input.psbtBytes, inputsToSign, networkType, 'Sign CAT-21 transaction').pipe((0, rxjs_1.switchMap)((signedPsbtBase64) => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.base64.decode(signedPsbtBase64))));
    },
    signPsbtOnly(input) {
        const networkType = (0, network_1.toBitcoinNetworkType)(input.network);
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const inputsToSign = targets.map((t) => ({
            address: t.address,
            signingIndexes: t.indexes,
            sigHash: t.sigHash,
        }));
        return callXverseSignTransaction(input.psbtBytes, inputsToSign, networkType, 'Sign CAT-21 buy offer (no broadcast)').pipe((0, rxjs_1.map)((signedPsbtBase64) => base_1.base64.decode(signedPsbtBase64)));
    },
};
exports.xverseSigner = {
    providerId: wallet_service_types_1.KnownOrdinalWalletType.xverse,
    ...(0, operation_named_defaults_1.operationNamedDefaults)(legacy),
};
//# sourceMappingURL=xverse.signer.js.map