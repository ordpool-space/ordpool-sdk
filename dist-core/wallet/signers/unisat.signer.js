"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unisatSigner = void 0;
const base_1 = require("@scure/base");
const rxjs_1 = require("rxjs");
const psbt_extract_1 = require("../psbt-extract");
const wallet_service_types_1 = require("../wallet.service.types");
const operation_named_defaults_1 = require("./operation-named-defaults");
const signing_targets_helper_1 = require("./signing-targets.helper");
/**
 * Unisat — `window.unisat.signPsbt(hex, {autoFinalized: false})`.
 *
 * Per the SDK-wide "WE broadcast" convention (see
 * `/Work/ordpool/WALLETS.md`): the wallet signs and hands back a
 * partial-sig PSBT; the SDK finalises and broadcasts via the
 * caller-supplied `input.broadcast` callback. We deliberately
 * SKIP `window.unisat.pushPsbt` — that would route to Unisat's
 * vendor backend (api.unisat.io), which takes broadcast-endpoint
 * choice away from the SDK and breaks regtest / Mara / accelerator
 * scenarios.
 *
 * Multi-input signing: Unisat's signPsbt accepts an optional
 * `toSignInputs: [{index, address, sighashTypes}]` list. The multi
 * method projects `signingMap` onto it so the wallet only signs the
 * inputs we asked for (important for buy-offer flows where the
 * buyer must NOT sign input 0, the seller's cat UTXO). Without
 * `toSignInputs`, Unisat tries to sign every input whose UTXO data
 * it owns — fine for mint, breaks offer-create.
 *
 * Caveat (CLAUDE.md): Unisat uses one address for both payments and
 * ordinals — easy to spend cat sats by accident. Mint flow surfaces
 * this in UI text. The signer itself can't help that.
 */
const legacy = {
    signAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const unisat = window.unisat;
        return (0, rxjs_1.from)(unisat.signPsbt(psbtHex, { autoFinalized: false })).pipe((0, rxjs_1.switchMap)(signedPsbtHex => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.hex.decode(signedPsbtHex))));
    },
    signMultiInputAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const unisat = window.unisat;
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const toSignInputs = [];
        for (const t of targets) {
            for (const i of t.indexes) {
                toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
            }
        }
        return (0, rxjs_1.from)(unisat.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe((0, rxjs_1.switchMap)(signedPsbtHex => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.hex.decode(signedPsbtHex))));
    },
    signPsbtOnly(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const unisat = window.unisat;
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const toSignInputs = [];
        for (const t of targets) {
            for (const i of t.indexes) {
                toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
            }
        }
        return (0, rxjs_1.from)(unisat.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe((0, rxjs_1.map)((signedPsbtHex) => base_1.hex.decode(signedPsbtHex)));
    },
};
exports.unisatSigner = {
    providerId: wallet_service_types_1.KnownOrdinalWalletType.unisat,
    ...(0, operation_named_defaults_1.operationNamedDefaults)(legacy),
};
//# sourceMappingURL=unisat.signer.js.map