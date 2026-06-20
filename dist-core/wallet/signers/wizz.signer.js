"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wizzSigner = void 0;
const base_1 = require("@scure/base");
const rxjs_1 = require("rxjs");
const psbt_extract_1 = require("../psbt-extract");
const wallet_service_types_1 = require("../wallet.service.types");
const operation_named_defaults_1 = require("./operation-named-defaults");
const signing_targets_helper_1 = require("./signing-targets.helper");
/**
 * Wizz — `window.wizz.signPsbt(hex, {autoFinalized: false})`.
 *
 * Wizz is a fork of Unisat (formerly Atom Wallet) and exposes the
 * same provider contract. Per the SDK-wide "WE broadcast" convention
 * (see `/Work/ordpool/WALLETS.md`): the wallet signs and hands back
 * a partial-sig PSBT; the SDK finalises and broadcasts via the
 * caller-supplied `input.broadcast` callback. We deliberately SKIP
 * `pushPsbt` — that would route to Wizz's vendor backend and take
 * broadcast-endpoint choice away from the SDK.
 *
 * Wizz also injects itself as `window.atom` (legacy Atom Wallet
 * namespace) for backwards compatibility; both bindings reference
 * the same provider via Proxy. Prefer `window.wizz`.
 */
const legacy = {
    signAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const wizz = window.wizz;
        return (0, rxjs_1.from)(wizz.signPsbt(psbtHex, { autoFinalized: false })).pipe((0, rxjs_1.switchMap)(signedPsbtHex => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.hex.decode(signedPsbtHex))));
    },
    signMultiInputAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const wizz = window.wizz;
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const toSignInputs = [];
        for (const t of targets) {
            for (const i of t.indexes) {
                toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
            }
        }
        return (0, rxjs_1.from)(wizz.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe((0, rxjs_1.switchMap)(signedPsbtHex => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.hex.decode(signedPsbtHex))));
    },
    signPsbtOnly(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const wizz = window.wizz;
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const toSignInputs = [];
        for (const t of targets) {
            for (const i of t.indexes) {
                toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
            }
        }
        return (0, rxjs_1.from)(wizz.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe((0, rxjs_1.map)((signedPsbtHex) => base_1.hex.decode(signedPsbtHex)));
    },
};
exports.wizzSigner = {
    providerId: wallet_service_types_1.KnownOrdinalWalletType.wizz,
    ...(0, operation_named_defaults_1.operationNamedDefaults)(legacy),
};
//# sourceMappingURL=wizz.signer.js.map