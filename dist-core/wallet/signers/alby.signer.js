"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.albySigner = void 0;
const base_1 = require("@scure/base");
const rxjs_1 = require("rxjs");
const sighash_1 = require("../sighash");
const wallet_service_types_1 = require("../wallet.service.types");
const operation_named_defaults_1 = require("./operation-named-defaults");
/**
 * Alby — `window.alby.webbtc.signPsbt(psbtHex, { sighashTypes })`.
 *
 * Alby's BTC sub-provider sits at `alby.webbtc` (verified iter 99
 * against background.bundle.js v3.14.2). signPsbt accepts the PSBT
 * as hex and returns `{ signed: <wire-tx-hex> }` — the wire-format
 * raw transaction hex, already finalised by Alby's internal
 * bitcoinjs-lib `extractTransaction().toHex()`. NOT a signed PSBT.
 * We broadcast that wire-tx directly.
 *
 * **Alby quirk every caller must respect** (verified iter 108
 * against background.bundle.js): Alby signs EVERY input in the
 * PSBT, no opt-in. The background-script's `bitcoin.signPsbt` does
 * `psbt.data.inputs.forEach(i => psbt.signTaprootInput(i, key))`
 * with the user's single key at `m/86'/1'/0'/0/0`. There is no
 * `signInputs` / `toSignInputs` knob — those args are dropped on
 * the floor. Caller MUST only hand Alby a PSBT whose inputs are
 * all the user's own UTXOs. For our cat21 mint (1 input, owner's
 * own UTXO, owner-pays-fee) this is fine.
 *
 * The `sighashTypes` whitelist IS forwarded to bitcoinjs-lib's
 * `signTaprootInput` `allowedSighashTypes` arg. Alby's default
 * whitelist (when the option is omitted) accepts only
 * SIGHASH_DEFAULT, so PSBTs with explicit SIGHASH_ALL get rejected.
 * We pass both DEFAULT (0x00) and ALL (0x01) so Alby accepts
 * whichever shape the SDK emits — per BIP-341 they're wire-
 * equivalent on key-path spends.
 *
 * Targets the Alby Browser Extension. Alby Go (mobile) doesn't
 * inject in-page providers — it uses NWC deeplinks, a completely
 * different integration model that this signer doesn't cover.
 */
const legacy = {
    signAndBroadcast(input) {
        const psbtHex = base_1.hex.encode(input.psbtBytes);
        const alby = window.alby;
        const p = (async () => {
            await alby.enable();
            if (alby.webbtc.enable)
                await alby.webbtc.enable();
            const { signed } = await alby.webbtc.signPsbt(psbtHex, {
                sighashTypes: [...sighash_1.BIP341_KEYPATH_SIGHASHES],
            });
            return signed;
        })();
        return (0, rxjs_1.from)(p).pipe(
        // Alby returns wire-tx hex (already finalised), not a signed
        // PSBT. Broadcast the hex directly — no extract step.
        (0, rxjs_1.switchMap)(txHex => input.broadcast(txHex)), (0, rxjs_1.map)(txId => ({ txId })));
    },
    /**
     * Multi-input flows (transfer, offer-create, offer-accept) cannot
     * be driven against Alby's current API: `signPsbt` signs every
     * input in the PSBT unconditionally (verified iter 108 against
     * background.bundle.js). That breaks offer-create where the buyer
     * must NOT sign input 0 (the seller's cat UTXO).
     *
     * For transfer specifically, where the user signs both the cat and
     * funding inputs but they're all the user's UTXOs, Alby's "sign
     * everything" would work — but Alby uses a single Taproot key at
     * `m/86'/1'/0'/0/0` for every signature, so a transfer that mixes
     * scriptTypes (cat at the user's taproot, funding at the user's
     * legacy address) would fail anyway. Until Alby exposes per-input
     * key derivation, multi-input flows raise here so the consumer
     * surfaces an unambiguous "this wallet doesn't support that flow yet".
     */
    signMultiInputAndBroadcast(_input) {
        return new rxjs_1.Observable((observer) => {
            observer.error(new Error('Alby does not support per-input signing yet (no toSignInputs / signInputs knob in current webbtc API). Use Xverse, Leather, Unisat, or CAT-21 wallet for transfer / offer flows.'));
        });
    },
    signPsbtOnly(_input) {
        return new rxjs_1.Observable((observer) => {
            observer.error(new Error('Alby does not support per-input signing yet (no toSignInputs / signInputs knob in current webbtc API). Use Xverse, Leather, Unisat, or CAT-21 wallet for offer-create.'));
        });
    },
};
exports.albySigner = {
    providerId: wallet_service_types_1.KnownOrdinalWalletType.alby,
    ...(0, operation_named_defaults_1.operationNamedDefaults)(legacy),
};
//# sourceMappingURL=alby.signer.js.map