"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.binanceSigner = void 0;
const base_1 = require("@scure/base");
const rxjs_1 = require("rxjs");
const psbt_extract_1 = require("../psbt-extract");
const sighash_1 = require("../sighash");
const wallet_service_types_1 = require("../wallet.service.types");
const operation_named_defaults_1 = require("./operation-named-defaults");
const signing_targets_helper_1 = require("./signing-targets.helper");
/**
 * Binance Web3 Wallet — `window.binancew3w.bitcoin.signPsbt(hex,
 * {autoFinalized: false, toSignInputs: […]})`.
 *
 * Shape pulled from the LaserEyes `binance.ts` provider
 * (omnisat/lasereyes-mono) which is in production use across
 * multiple Ordinals-related projects, cross-checked against the
 * developer docs at developers.binance.com/docs/binance-w3w
 * /bitcoin-provider. Per the SDK-wide "WE broadcast" convention,
 * we pass `autoFinalized: false` and route through the shared
 * broadcastSignedPsbt helper.
 *
 * **Runtime status:** the shipped v1.17.2 binary doesn't inject
 * `window.binancew3w.bitcoin` (only wallet / ethereum / solana /
 * tron / sui / tonconnect), so this signer is unreachable on
 * current Binance Web3 Wallet installs. Detect-by-signature in
 * `binance.connector.ts` correctly returns false, so the wallet
 * doesn't surface in the picker and this code isn't called.
 * Ships as potential-support; lights up automatically when
 * Binance enables the documented surface.
 */
const legacy = {
    signAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const binanceBtc = window.binancew3w.bitcoin;
        return (0, rxjs_1.from)(binanceBtc.signPsbt(psbtHex, {
            autoFinalized: false,
            toSignInputs: [{
                    index: 0,
                    address: input.paymentAddress,
                    // BIP-341 key-path: DEFAULT (0x00) and ALL (0x01) cover
                    // identical wire bytes; accept either so the wallet's
                    // policy check passes regardless of which shape the SDK
                    // emits on the Taproot input.
                    sighashTypes: [...sighash_1.BIP341_KEYPATH_SIGHASHES],
                }],
        })).pipe((0, rxjs_1.switchMap)(signedPsbtHex => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.hex.decode(signedPsbtHex))));
    },
    signMultiInputAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const binanceBtc = window.binancew3w.bitcoin;
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const toSignInputs = [];
        for (const t of targets) {
            for (const i of t.indexes) {
                toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
            }
        }
        return (0, rxjs_1.from)(binanceBtc.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe((0, rxjs_1.switchMap)(signedPsbtHex => (0, psbt_extract_1.broadcastSignedPsbt)(input, base_1.hex.decode(signedPsbtHex))));
    },
    signPsbtOnly(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const binanceBtc = window.binancew3w.bitcoin;
        const targets = (0, signing_targets_helper_1.resolveSigningTargets)(input);
        const toSignInputs = [];
        for (const t of targets) {
            for (const i of t.indexes) {
                toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
            }
        }
        return (0, rxjs_1.from)(binanceBtc.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe((0, rxjs_1.map)((signedPsbtHex) => base_1.hex.decode(signedPsbtHex)));
    },
};
exports.binanceSigner = {
    providerId: wallet_service_types_1.KnownOrdinalWalletType.binance,
    ...(0, operation_named_defaults_1.operationNamedDefaults)(legacy),
};
//# sourceMappingURL=binance.signer.js.map