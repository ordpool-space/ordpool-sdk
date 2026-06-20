"use strict";
/**
 * Bulletproof validation gate for the four cat21 mutating operations.
 *
 * Single entry: `validateCat21Operation({ config, operation })`.
 *
 * Failure mode is a typed discriminated union — no exceptions, no
 * phantom `Validated<I>` brand. The success branch hands back
 * pre-decoded resources (scriptPubKey, parsed catId pieces) so
 * downstream code never re-decodes.
 *
 * Spec coverage is exhaustive: every member of `Cat21GateRejectReason`
 * has a dedicated test in `cat21-operation-gate.spec.ts`.
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
exports.validateCat21Operation = validateCat21Operation;
const base_1 = require("@scure/base");
const btc = __importStar(require("@scure/btc-signer"));
const cat21_postage_1 = require("../cat21-protocol/cat21-postage");
const network_1 = require("../network");
/* ──────────────────────────  Public entry  ────────────────────────── */
function validateCat21Operation(args) {
    const { config, operation } = args;
    if (!isObject(operation) || typeof operation.kind !== 'string') {
        return reject('intent-not-an-object');
    }
    if (!isObject(operation.intent)) {
        return reject('intent-not-an-object');
    }
    // Operation-kind allowlist runs BEFORE per-operation validation so
    // a wallet-configured "mint only" agent's transfer attempt fails
    // closed without exposing per-transfer field-level reasons (which
    // a curious agent could probe for capability-leak info).
    if (Array.isArray(config.allowedOperations) &&
        config.allowedOperations.length > 0 &&
        !config.allowedOperations.includes(operation.kind)) {
        return reject('operation-kind-not-allowed', operation.kind);
    }
    switch (operation.kind) {
        case 'mint':
            return validateMint(operation.intent, config);
        case 'transfer':
            return validateTransfer(operation.intent, config);
        case 'create_offer':
            return validateCreateOffer(operation.intent, config);
        case 'accept_offer':
            return validateAcceptOffer(operation.intent, config);
        case 'inscribe':
            return validateInscribe(operation.intent, config);
        default: {
            // Exhaustiveness: any new `kind` member trips a TS error here
            // BEFORE it reaches the runtime check.
            const _exhaustive = operation;
            void _exhaustive;
            return reject('unsupported-operation-kind', safeStringify(operation.kind));
        }
    }
}
/* ──────────────────────────  Per-operation  ────────────────────────── */
function validateMint(intent, config) {
    const recipient = validateAddress(intent.recipient, config, 'recipient');
    if (!recipient.ok)
        return recipient.result;
    const targetNet = (0, network_1.toScureNetwork)(config.network);
    if (config.allowedRecipients && config.allowedRecipients.length > 0) {
        if (!allowlistContainsAddress(intent.recipient, config.allowedRecipients, targetNet)) {
            return reject('recipient-not-allowed', intent.recipient);
        }
    }
    if (config.ownPaymentAddress &&
        addressesEquivalent(intent.recipient, config.ownPaymentAddress, targetNet)) {
        return reject('self-send', intent.recipient);
    }
    const fee = validateFeeRate(intent.feeRate, config);
    if (!fee.ok)
        return fee.result;
    let tipScript;
    if (intent.tip != null) {
        const tipResult = validateTip(intent.tip, config);
        if (!tipResult.ok)
            return tipResult.result;
        tipScript = tipResult.script;
    }
    return success({ kind: 'mint', recipientScript: recipient.script, tipScript });
}
function validateTransfer(intent, config) {
    const cat = parseCatId(intent.catId);
    if (!cat.ok)
        return reject('cat-id-malformed', intent.catId);
    const recipient = validateAddress(intent.recipient, config, 'recipient');
    if (!recipient.ok)
        return recipient.result;
    const targetNet = (0, network_1.toScureNetwork)(config.network);
    if (config.allowedRecipients && config.allowedRecipients.length > 0) {
        if (!allowlistContainsAddress(intent.recipient, config.allowedRecipients, targetNet)) {
            return reject('recipient-not-allowed', intent.recipient);
        }
    }
    if (config.ownPaymentAddress &&
        addressesEquivalent(intent.recipient, config.ownPaymentAddress, targetNet)) {
        return reject('self-send', intent.recipient);
    }
    const fee = validateFeeRate(intent.feeRate, config);
    if (!fee.ok)
        return fee.result;
    return success({
        kind: 'transfer',
        recipientScript: recipient.script,
        catTxid: cat.txid,
        catIndex: cat.index,
    });
}
function validateCreateOffer(intent, config) {
    const cat = parseCatId(intent.catId);
    if (!cat.ok)
        return reject('cat-id-malformed', intent.catId);
    const price = validatePrice(intent.priceSats, config);
    if (!price.ok)
        return price.result;
    const payment = validateAddress(intent.paymentAddress, config, 'payment-address');
    if (!payment.ok)
        return payment.result;
    if (config.allowedCounterparties && config.allowedCounterparties.length > 0) {
        const targetNet = (0, network_1.toScureNetwork)(config.network);
        if (!allowlistContainsAddress(intent.paymentAddress, config.allowedCounterparties, targetNet)) {
            return reject('payment-address-not-allowed', intent.paymentAddress);
        }
    }
    return success({
        kind: 'create_offer',
        paymentScript: payment.script,
        catTxid: cat.txid,
        catIndex: cat.index,
    });
}
function validateAcceptOffer(intent, config) {
    const cat = parseCatId(intent.expectedCatId);
    if (!cat.ok)
        return reject('expected-cat-id-malformed', intent.expectedCatId);
    const priceCheck = validateExpectedPrice(intent.expectedPriceSats);
    if (!priceCheck.ok)
        return priceCheck.result;
    const utxoOk = isWellFormedUtxoRef(intent.expectedSellerUtxo);
    if (!utxoOk) {
        return reject('expected-seller-utxo-malformed', JSON.stringify(intent.expectedSellerUtxo));
    }
    if (typeof intent.offerPsbt === 'string' &&
        intent.offerPsbt.length > (config.maxOfferPsbtBytes ?? DEFAULT_MAX_OFFER_PSBT_BYTES) * 2) {
        // Reject before base64-decoding when the raw string is already
        // larger than the cap × 2 (base64 expansion factor is ~4/3, but
        // hex is 2x; ×2 covers the worst case). DoS guard against an
        // agent flooding the wallet with a huge PSBT.
        return reject('offer-psbt-too-large', `${intent.offerPsbt.length} chars > ${(config.maxOfferPsbtBytes ?? DEFAULT_MAX_OFFER_PSBT_BYTES) * 2}`);
    }
    const psbtBytes = tryDecodePsbt(intent.offerPsbt);
    if (!psbtBytes)
        return reject('offer-psbt-malformed');
    if (!startsWithPsbtMagic(psbtBytes)) {
        return reject('offer-psbt-missing-magic-bytes');
    }
    const cap = config.maxOfferPsbtBytes ?? DEFAULT_MAX_OFFER_PSBT_BYTES;
    if (psbtBytes.length > cap) {
        return reject('offer-psbt-too-large', `${psbtBytes.length} > ${cap}`);
    }
    return success({
        kind: 'accept_offer',
        offerPsbtBytes: psbtBytes,
        catTxid: cat.txid,
        catIndex: cat.index,
    });
}
function validateInscribe(intent, config) {
    // Recipient — same address-validation pipeline as mint / transfer.
    const recipient = validateAddress(intent.recipient, config, 'recipient');
    if (!recipient.ok)
        return recipient.result;
    const targetNet = (0, network_1.toScureNetwork)(config.network);
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
    const cap = config.maxInscribeContentBytes ?? DEFAULT_MAX_INSCRIBE_CONTENT_BYTES;
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
 * cap with room to spare for the envelope overhead + witness +
 * sighash. Phase-3 lifts this when the Slipstream big-inscribe
 * path lands. Override via `config.maxInscribeContentBytes`.
 */
const DEFAULT_MAX_INSCRIBE_CONTENT_BYTES = 350_000;
/**
 * 128 KiB default cap. Real CAT-21 buy offers are ~600 bytes; this
 * leaves comfortable headroom while still rejecting a 1 MB DoS blob.
 * Override via `config.maxOfferPsbtBytes`.
 */
const DEFAULT_MAX_OFFER_PSBT_BYTES = 128 * 1024;
const PSBT_MAGIC_BYTES = Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff]);
function startsWithPsbtMagic(bytes) {
    if (bytes.length < PSBT_MAGIC_BYTES.length)
        return false;
    for (let i = 0; i < PSBT_MAGIC_BYTES.length; i++) {
        if (bytes[i] !== PSBT_MAGIC_BYTES[i])
            return false;
    }
    return true;
}
function malformedReason(field) {
    return `${field}-not-a-bitcoin-address`;
}
function wrongNetworkReason(field) {
    return `${field}-wrong-network`;
}
function validateAddress(address, config, field) {
    if (typeof address !== 'string' || address.length === 0) {
        return { ok: false, result: reject(malformedReason(field), safeStringify(address)) };
    }
    const targetNet = (0, network_1.toScureNetwork)(config.network);
    // Try the target network first; record whether the address parsed on
    // the OTHER network so the failure can be 'wrong-network' instead of
    // 'malformed' for an otherwise valid string.
    try {
        const decoded = btc.Address(targetNet).decode(address);
        const script = btc.OutScript.encode(decoded);
        return { ok: true, script };
    }
    catch {
        const otherNet = config.network === network_1.Network.Mainnet ? btc.TEST_NETWORK : btc.NETWORK;
        try {
            btc.Address(otherNet).decode(address);
            return { ok: false, result: reject(wrongNetworkReason(field), address) };
        }
        catch {
            return { ok: false, result: reject(malformedReason(field), address) };
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
function validateTip(tip, config) {
    if (typeof tip.value !== 'number' || !Number.isFinite(tip.value)) {
        return { ok: false, result: reject('tip-value-not-finite-number', safeStringify(tip.value)) };
    }
    if (!Number.isInteger(tip.value)) {
        return { ok: false, result: reject('tip-value-not-integer', safeStringify(tip.value)) };
    }
    if (tip.value < 0) {
        return { ok: false, result: reject('tip-value-negative', safeStringify(tip.value)) };
    }
    const tipCap = config.maxTipValueSats ?? config.maxPriceSats;
    if (tipCap != null && tip.value > tipCap) {
        return { ok: false, result: reject('tip-value-above-cap', `${tip.value} > ${tipCap}`) };
    }
    if (tip.value === 0) {
        // Builder skips the output entirely. Address irrelevant.
        return { ok: true, script: undefined };
    }
    const tipAddr = validateAddress(tip.address, config, 'tip-address');
    if (!tipAddr.ok)
        return tipAddr;
    return { ok: true, script: tipAddr.script };
}
function validatePrice(priceSats, config) {
    if (typeof priceSats !== 'number' || !Number.isFinite(priceSats)) {
        return { ok: false, result: reject('price-not-finite-number', safeStringify(priceSats)) };
    }
    if (!Number.isInteger(priceSats)) {
        return { ok: false, result: reject('price-not-integer', safeStringify(priceSats)) };
    }
    if (priceSats <= 0) {
        return { ok: false, result: reject('price-not-positive', safeStringify(priceSats)) };
    }
    if (priceSats < cat21_postage_1.CAT21_POSTAGE_SATS) {
        return {
            ok: false,
            result: reject('price-below-postage-floor', `${priceSats} < ${cat21_postage_1.CAT21_POSTAGE_SATS}`),
        };
    }
    if (config.maxPriceSats != null && priceSats > config.maxPriceSats) {
        return {
            ok: false,
            result: reject('price-above-cap', `${priceSats} > ${config.maxPriceSats}`),
        };
    }
    return { ok: true };
}
function validateExpectedPrice(expectedPriceSats) {
    if (typeof expectedPriceSats !== 'number' || !Number.isFinite(expectedPriceSats)) {
        return {
            ok: false,
            result: reject('expected-price-not-finite-number', safeStringify(expectedPriceSats)),
        };
    }
    if (!Number.isInteger(expectedPriceSats)) {
        return { ok: false, result: reject('expected-price-not-integer', safeStringify(expectedPriceSats)) };
    }
    if (expectedPriceSats <= 0) {
        return { ok: false, result: reject('expected-price-not-positive', safeStringify(expectedPriceSats)) };
    }
    return { ok: true };
}
/* ──────────────────────────  Pure shape helpers  ────────────────────── */
const CAT_ID_RE = /^([0-9a-f]{64})i(\d+)$/;
function parseCatId(value) {
    if (typeof value !== 'string')
        return { ok: false };
    const m = CAT_ID_RE.exec(value);
    if (!m)
        return { ok: false };
    const index = Number.parseInt(m[2], 10);
    if (!Number.isFinite(index) || index < 0)
        return { ok: false };
    return { ok: true, txid: m[1], index };
}
const TXID_RE = /^[0-9a-f]{64}$/;
function isWellFormedUtxoRef(value) {
    if (!isObject(value))
        return false;
    const v = value;
    if (typeof v.txid !== 'string' || !TXID_RE.test(v.txid))
        return false;
    if (typeof v.vout !== 'number')
        return false;
    if (!Number.isInteger(v.vout) || v.vout < 0)
        return false;
    return true;
}
/**
 * Try both hex and base64 decoders; prefer the one whose bytes start
 * with the PSBT magic (`0x70 0x73 0x62 0x74 0xff`). Falls back to
 * the first successful decode when neither has the magic, so the
 * caller's magic check fires with the right reason.
 *
 * The two encodings share the lowercase a–f alphabet (base64
 * includes them, hex uses them), so a string like `70736274ff…`
 * is valid BOTH ways but only the hex result carries the PSBT
 * magic. Pick the one that does.
 */
function tryDecodePsbt(value) {
    if (typeof value !== 'string' || value.length === 0)
        return undefined;
    const hexBytes = tryHex(value);
    if (hexBytes && startsWithPsbtMagic(hexBytes))
        return hexBytes;
    const b64Bytes = tryBase64(value);
    if (b64Bytes && startsWithPsbtMagic(b64Bytes))
        return b64Bytes;
    // Neither decoded result has the magic; return whichever decoded
    // at all so the caller's missing-magic check can fire instead of
    // a generic 'malformed'.
    return hexBytes ?? b64Bytes ?? undefined;
}
function tryHex(value) {
    try {
        const decoded = base_1.hex.decode(value);
        return decoded.length > 0 ? decoded : undefined;
    }
    catch {
        return undefined;
    }
}
function tryBase64(value) {
    try {
        const decoded = base_1.base64.decode(value);
        return decoded.length > 0 ? decoded : undefined;
    }
    catch {
        return undefined;
    }
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Stringify any input — including Symbol, BigInt, prototype-less
 * objects — without throwing. `String(Symbol())` throws TypeError;
 * `String.prototype.toString` on Object.create(null) throws too.
 * The detail field is debug telemetry only, so a "[Symbol]"
 * placeholder is more useful than a runtime crash.
 */
/**
 * Compare two addresses for protocol-level equivalence by decoding
 * both to scriptPubKey bytes and comparing those. Defends against:
 *
 *   - BIP173 uppercase/lowercase: `BC1QW508…` and `bc1qw508…` are
 *     the same address (scure accepts both), so a config storing
 *     one form must also match the other.
 *   - Mixed encodings: `bc1q…` (bech32, P2WPKH) and `3…` (P2SH-
 *     wrapped) decode to different scripts — correctly different
 *     addresses. Different scripts → different bytes → unequal.
 *   - Address-set lookup-by-string with a config that has typos /
 *     whitespace: throws on decode, so the check returns `false`
 *     (the candidate is rejected, but the gate doesn't crash).
 *
 * Returns `false` on any decode failure of EITHER address. Caller
 * decides what to do — typically "reject as not-equivalent and
 * surface a typed reason elsewhere".
 */
function addressesEquivalent(a, b, network) {
    let aScript;
    let bScript;
    try {
        aScript = btc.OutScript.encode(btc.Address(network).decode(a));
        bScript = btc.OutScript.encode(btc.Address(network).decode(b));
    }
    catch {
        return false;
    }
    if (aScript.length !== bScript.length)
        return false;
    for (let i = 0; i < aScript.length; i++) {
        if (aScript[i] !== bScript[i])
            return false;
    }
    return true;
}
/**
 * Test whether `candidate` is equivalent (in the
 * `addressesEquivalent` sense) to any address in `allowlist`. Returns
 * `false` on any decode failure inside the loop so a malformed
 * allowlist entry doesn't crash the check.
 */
function allowlistContainsAddress(candidate, allowlist, network) {
    for (const entry of allowlist) {
        if (addressesEquivalent(candidate, entry, network))
            return true;
    }
    return false;
}
function safeStringify(value) {
    try {
        if (typeof value === 'symbol')
            return value.toString();
        if (typeof value === 'bigint')
            return `${value}n`;
        return String(value);
    }
    catch {
        return Object.prototype.toString.call(value);
    }
}
function reject(reason, detail) {
    return detail != null ? { ok: false, reason, detail } : { ok: false, reason };
}
function success(resources) {
    return { ok: true, resources };
}
//# sourceMappingURL=cat21-operation-gate.js.map