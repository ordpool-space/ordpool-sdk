"use strict";
/**
 * Inscribe operation validation gate. Parallel to
 * `validateCat21Operation` from `cat21-validation/`, separate by
 * design (different protocol, different consumer set). See the
 * types file for the full rationale.
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
exports.validateInscribeOperation = validateInscribeOperation;
const btc = __importStar(require("@scure/btc-signer"));
const network_1 = require("../network");
/* ──────────────────────────  Public entry  ────────────────────────── */
function validateInscribeOperation(args) {
    const { config, operation } = args;
    if (!isObject(operation) || typeof operation.kind !== 'string') {
        return reject('intent-not-an-object');
    }
    if (!isObject(operation.intent)) {
        return reject('intent-not-an-object');
    }
    switch (operation.kind) {
        case 'inscribe':
            return validateInscribe(operation.intent, config);
        default: {
            const _exhaust = operation.kind;
            return reject('unsupported-operation-kind', safeStringify(_exhaust));
        }
    }
}
/* ──────────────────────────  Per-operation  ────────────────────────── */
function validateInscribe(intent, config) {
    // Recipient.
    const recipient = validateAddress(intent.recipient, config);
    if (!recipient.ok)
        return recipient.result;
    const targetNet = toScureNetwork(config.network);
    if (config.allowedRecipients && config.allowedRecipients.length > 0) {
        if (!allowlistContainsAddress(intent.recipient, config.allowedRecipients, targetNet)) {
            return reject('recipient-not-allowed', intent.recipient);
        }
    }
    if (config.ownPaymentAddress &&
        addressesEquivalent(intent.recipient, config.ownPaymentAddress, targetNet)) {
        return reject('self-send', intent.recipient);
    }
    // Fee rate.
    const fee = validateFeeRate(intent.feeRate, config);
    if (!fee.ok)
        return fee.result;
    // Content body.
    if (!ArrayBuffer.isView(intent.body) || intent.body.constructor.name !== 'Uint8Array') {
        return reject('content-not-bytes', safeStringify(typeof intent.body));
    }
    const cap = config.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
    if (intent.body.length > cap) {
        return reject('content-too-large', `body=${intent.body.length} cap=${cap}`);
    }
    // Content type — optional, validated when present.
    let normalisedContentType;
    if (intent.contentType !== undefined) {
        if (typeof intent.contentType !== 'string') {
            return reject('content-type-not-string', safeStringify(typeof intent.contentType));
        }
        normalisedContentType = intent.contentType.toLowerCase().trim();
        // Defensive blocklist runs FIRST. A misconfigured allowlist that
        // accidentally permits `application/javascript` (a JS XSS vector
        // inside inscribed HTML) still loses to the blocklist.
        if (config.blockedContentTypes && config.blockedContentTypes.length > 0) {
            const blockedLower = config.blockedContentTypes.map(s => s.toLowerCase().trim());
            if (blockedLower.includes(normalisedContentType)) {
                return reject('content-type-blocked', intent.contentType);
            }
        }
        if (config.allowedContentTypes && config.allowedContentTypes.length > 0) {
            const allowedLower = config.allowedContentTypes.map(s => s.toLowerCase().trim());
            if (!allowedLower.includes(normalisedContentType)) {
                return reject('content-type-not-allowed', intent.contentType);
            }
        }
    }
    return success({
        kind: 'inscribe',
        recipientScript: recipient.script,
        contentBytes: intent.body,
        contentType: normalisedContentType,
    });
}
/**
 * 350 KB default cap on inscription body bytes. Phase-1 hard
 * ceiling — keeps the reveal tx under the ~400 kWU standard relay
 * cap. Override via `config.maxContentBytes`.
 */
const DEFAULT_MAX_CONTENT_BYTES = 350_000;
/* ──────────────────────────  Helpers  ────────────────────────── */
function validateAddress(address, config) {
    if (typeof address !== 'string' || address.length === 0) {
        return { ok: false, result: reject('recipient-not-a-bitcoin-address', safeStringify(address)) };
    }
    const targetNet = toScureNetwork(config.network);
    try {
        const decoded = btc.Address(targetNet).decode(address);
        const script = btc.OutScript.encode(decoded);
        return { ok: true, script };
    }
    catch {
        const otherNet = config.network === network_1.Network.Mainnet ? btc.TEST_NETWORK : btc.NETWORK;
        try {
            btc.Address(otherNet).decode(address);
            return { ok: false, result: reject('recipient-wrong-network', address) };
        }
        catch {
            return { ok: false, result: reject('recipient-not-a-bitcoin-address', address) };
        }
    }
}
function validateFeeRate(feeRate, config) {
    if (typeof feeRate !== 'number' || !Number.isFinite(feeRate)) {
        return { ok: false, result: reject('fee-rate-not-finite-number', safeStringify(feeRate)) };
    }
    if (!Number.isInteger(feeRate)) {
        return { ok: false, result: reject('fee-rate-not-integer', safeStringify(feeRate)) };
    }
    if (feeRate <= 0) {
        return { ok: false, result: reject('fee-rate-not-positive', safeStringify(feeRate)) };
    }
    if (config.maxFeeRatePerVbyte != null && feeRate > config.maxFeeRatePerVbyte) {
        return {
            ok: false,
            result: reject('fee-rate-above-cap', `${feeRate} > ${config.maxFeeRatePerVbyte}`),
        };
    }
    return { ok: true };
}
function addressesEquivalent(a, b, network) {
    if (a === b)
        return true;
    try {
        const da = btc.Address(network).decode(a);
        const db = btc.Address(network).decode(b);
        const sa = btc.OutScript.encode(da);
        const sb = btc.OutScript.encode(db);
        if (sa.length !== sb.length)
            return false;
        for (let i = 0; i < sa.length; i++)
            if (sa[i] !== sb[i])
                return false;
        return true;
    }
    catch {
        return false;
    }
}
function allowlistContainsAddress(address, allowlist, network) {
    for (const entry of allowlist) {
        if (addressesEquivalent(address, entry, network))
            return true;
    }
    return false;
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeStringify(value) {
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
function reject(reason, detail) {
    return { ok: false, reason, detail };
}
function success(resources) {
    return { ok: true, resources };
}
function toScureNetwork(n) {
    return n === network_1.Network.Mainnet ? btc.NETWORK : btc.TEST_NETWORK;
}
//# sourceMappingURL=inscribe-operation-gate.js.map