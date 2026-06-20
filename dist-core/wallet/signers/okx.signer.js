"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.okxSigner = void 0;
const base_1 = require("@scure/base");
const rxjs_1 = require("rxjs");
const psbt_extract_1 = require("../psbt-extract");
const sighash_1 = require("../sighash");
const wallet_service_types_1 = require("../wallet.service.types");
const operation_named_defaults_1 = require("./operation-named-defaults");
const signing_targets_helper_1 = require("./signing-targets.helper");
/**
 * OKX — `window.okxwallet.bitcoin.signPsbt(hex, {autoFinalized:
 * false})`.
 *
 * OKX is a multi-chain wallet; the BTC sub-provider lives at
 * `window.okxwallet.bitcoin`. Its signPsbt accepts the same
 * `autoFinalized` option as Unisat (verified by grepping
 * inpage.js v4.1.0). Per the SDK-wide "WE broadcast" convention,
 * we skip OKX's `sendPsbt` and broadcast via the caller-supplied
 * `input.broadcast` callback.
 *
 * Multi-input signing: OKX follows the Unisat-derived
 * `toSignInputs` convention. Same mapping as the unisat signer.
 */
const legacy = {
    signAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const okxBtc = window.okxwallet.bitcoin;
        // OKX validates `toSignInputs[i].address` against its own wallet
        // address-set. Passing the input.paymentAddress lets the caller
        // (orchestrator or Pipeline B harness in cross-network mode) tell
        // OKX exactly which address to sign with, instead of OKX trying
        // to infer from the PSBT's scriptPubKey (which won't match its
        // mainnet view on a regtest PSBT).
        return (0, rxjs_1.from)(okxBtc.signPsbt(psbtHex, {
            autoFinalized: false,
            toSignInputs: [{
                    index: 0,
                    address: input.paymentAddress,
                    // BIP-341 key-path DEFAULT (0x00) and ALL (0x01) commit to
                    // identical wire bytes; accept either so OKX's policy check
                    // passes regardless of which shape the PSBT emits.
                    sighashTypes: [...sighash_1.BIP341_KEYPATH_SIGHASHES],
                }],
        })).pipe((0, rxjs_1.switchMap)(signedPsbtHex => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.hex.decode(signedPsbtHex))));
    },
    signMultiInputAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const okxBtc = window.okxwallet.bitcoin;
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const toSignInputs = [];
        for (const t of targets) {
            for (const i of t.indexes) {
                toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
            }
        }
        return (0, rxjs_1.from)(okxBtc.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe((0, rxjs_1.switchMap)(signedPsbtHex => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.hex.decode(signedPsbtHex))));
    },
    signPsbtOnly(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const okxBtc = window.okxwallet.bitcoin;
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const toSignInputs = [];
        for (const t of targets) {
            for (const i of t.indexes) {
                toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
            }
        }
        return (0, rxjs_1.from)(okxBtc.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe((0, rxjs_1.map)((signedPsbtHex) => base_1.hex.decode(signedPsbtHex)));
    },
};
exports.okxSigner = {
    providerId: wallet_service_types_1.KnownOrdinalWalletType.okx,
    ...(0, operation_named_defaults_1.operationNamedDefaults)(legacy),
};
//# sourceMappingURL=okx.signer.js.map