"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.oylSigner = void 0;
const base_1 = require("@scure/base");
const rxjs_1 = require("rxjs");
const psbt_extract_1 = require("../psbt-extract");
const wallet_service_types_1 = require("../wallet.service.types");
const operation_named_defaults_1 = require("./operation-named-defaults");
const signing_targets_helper_1 = require("./signing-targets.helper");
/**
 * Oyl — `window.oyl.signPsbt({psbt, inputsToSign, broadcast,
 * finalize})`.
 *
 * Oyl exposes a single `window.oyl` provider whose methods route
 * via its relay-based messaging shim to the extension background.
 *
 * Schema verified by grepping v1.17.1's static/background/index.js
 * (signPsbt handler at byte 4708500):
 *   - `body.psbt` is a hex string. The error message
 *     "A psbt hex is required" refers to the value TYPE, not the
 *     field name; passing base64 here gets rejected.
 *   - Response may use `signedPsbtHex` (hex), `signedPsbt` (base64),
 *     or `psbt` (whichever shape Oyl emits for that version). The
 *     signer normalises by sniffing.
 *
 * Per the SDK-wide "WE broadcast" convention, we set
 * `broadcast: false, finalize: false` so Oyl returns the
 * partial-sig PSBT for us to finalize via scure +
 * broadcastSignedPsbt.
 */
function decodeOylResponse(r) {
    if (r.signedPsbtHex)
        return base_1.hex.decode(r.signedPsbtHex);
    if (r.signedPsbt)
        return base_1.base64.decode(r.signedPsbt);
    if (r.psbt) {
        return /^[0-9a-f]+$/i.test(r.psbt) ? base_1.hex.decode(r.psbt) : base_1.base64.decode(r.psbt);
    }
    throw new Error('Oyl signPsbt response carried no signed-psbt field');
}
const legacy = {
    signAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const oyl = window.oyl;
        const signPromise = oyl.signPsbt({
            psbt: psbtHex,
            inputsToSign: [{ address: input.paymentAddress, signingIndexes: [0], sigHash: 0x01 }],
            broadcast: false,
            finalize: false,
        });
        return (0, rxjs_1.from)(signPromise).pipe((0, rxjs_1.switchMap)(response => (0, psbt_extract_1.broadcastSignedPsbt)(input, decodeOylResponse(response))));
    },
    signMultiInputAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const oyl = window.oyl;
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const inputsToSign = targets.map((t) => ({
            address: t.address,
            signingIndexes: t.indexes,
            sigHash: t.sigHash,
        }));
        const signPromise = oyl.signPsbt({
            psbt: psbtHex,
            inputsToSign,
            broadcast: false,
            finalize: false,
        });
        return (0, rxjs_1.from)(signPromise).pipe((0, rxjs_1.switchMap)(response => (0, psbt_extract_1.broadcastSignedPsbt)(input, decodeOylResponse(response))));
    },
    signPsbtOnly(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const oyl = window.oyl;
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const inputsToSign = targets.map((t) => ({
            address: t.address,
            signingIndexes: t.indexes,
            sigHash: t.sigHash,
        }));
        return (0, rxjs_1.from)(oyl.signPsbt({
            psbt: psbtHex,
            inputsToSign,
            broadcast: false,
            finalize: false,
        })).pipe((0, rxjs_1.map)((response) => decodeOylResponse(response)));
    },
};
exports.oylSigner = {
    providerId: wallet_service_types_1.KnownOrdinalWalletType.oyl,
    ...(0, operation_named_defaults_1.operationNamedDefaults)(legacy),
};
//# sourceMappingURL=oyl.signer.js.map