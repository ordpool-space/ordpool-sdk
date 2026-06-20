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
exports.CAT21_MINT_CHANGE_DUST_LIMIT_SATS = exports.CAT21_MINT_POSTAGE_SATS = void 0;
exports.buildCat21MintPsbt = buildCat21MintPsbt;
const btc = __importStar(require("@scure/btc-signer"));
const cat21_postage_1 = require("../cat21-protocol/cat21-postage");
const network_1 = require("../network");
const cat21_sequence_1 = require("../cat21-protocol/cat21-sequence");
/**
 * Alias for {@link CAT21_POSTAGE_SATS}. The canonical constant lives in
 * `cat21-postage.ts`; this re-export exists for legacy import paths.
 */
exports.CAT21_MINT_POSTAGE_SATS = cat21_postage_1.CAT21_POSTAGE_SATS;
/**
 * Dust threshold for the change output. 546 sats is the conservative
 * cross-address-type floor (taproot 330, segwit 294, p2sh 540 — 546
 * clears them all).
 */
exports.CAT21_MINT_CHANGE_DUST_LIMIT_SATS = 546;
/**
 * Builds the unsigned CAT-21 mint PSBT — the simplified wallet-friendly
 * shape parallel to `buildCat21TransferPsbt` and
 * `buildCat21BuyOfferPsbt`. For the full multi-wallet path with
 * Unisat-specific script handling, see `createTransaction` in
 * `cat21.service.helper.ts`.
 *
 * Structure:
 *   Input 0  — funding UTXO. The first sat of this UTXO becomes the
 *              first sat of output 0 by ordinal-theory FIFO, which is
 *              where cat21-ord mints the new cat.
 *   Output 0 — recipient address, postage sats. Cat lands here.
 *   Output 1 — optional developer-tip output (skipped when value=0).
 *   Output N — change to sender (skipped when sub-dust; absorbed into
 *              miner fee). N = 1 with no tip, N = 2 with tip.
 *
 * Hard invariants (asserted before return):
 *   1. `lockTime === 21`.
 *   2. Every input's sequence matches the per-wallet rule.
 *   3. Every input carries SIGHASH_ALL.
 */
function buildCat21MintPsbt(args) {
    // HARD RULE: cat output is always exactly 546 sats. The cat is born
    // at the first sat of output 0; uniform postage across mint /
    // transfer / offer means a cat UTXO is fungible across address types.
    // See SDK CLAUDE.md "cat UTXO is always 546 sats".
    const postageSats = cat21_postage_1.CAT21_POSTAGE_SATS;
    if (args.feeSats < 0)
        throw new Error('feeSats must be non-negative');
    const tipValueSats = args.destinations.tip?.valueSats ?? 0;
    if (tipValueSats < 0)
        throw new Error('tip.valueSats must be non-negative');
    const scureNetwork = (0, network_1.toScureNetwork)(args.network);
    const sequence = (0, cat21_sequence_1.resolveCat21InputSequence)(args.walletType);
    const tx = new btc.Transaction({
        lockTime: 21,
        allowLegacyWitnessUtxo: true,
        disableScriptCheck: true,
    });
    // Input 0: the funding UTXO. The first sat of this UTXO becomes the
    // first sat of output 0; cat21-ord mints the cat there.
    addInput(tx, args.fundingInput, sequence);
    // Output 0: recipient (cat lands here).
    tx.addOutputAddress(args.destinations.recipientAddress, BigInt(postageSats), scureNetwork);
    // Output 1: optional tip.
    if (tipValueSats > 0 && args.destinations.tip) {
        tx.addOutputAddress(args.destinations.tip.address, BigInt(tipValueSats), scureNetwork);
    }
    // Change calculation. The dust threshold is the smaller of (a) the
    // builder default 546 and (b) the caller-supplied per-address-type
    // floor (cat21.space passes `getMinimumUtxoSize(paymentAddress)`).
    const changeDustLimit = args.changeDustLimitSats ?? exports.CAT21_MINT_CHANGE_DUST_LIMIT_SATS;
    const required = postageSats + tipValueSats + args.feeSats;
    const changeRaw = args.fundingInput.value - required;
    if (changeRaw < 0) {
        throw new Error(`Mint funding insufficient: ${args.fundingInput.value} sats < ${required} sats required`);
    }
    let changeSats = 0;
    let absorbedIntoFee = 0;
    if (changeRaw >= changeDustLimit) {
        changeSats = changeRaw;
        tx.addOutputAddress(args.destinations.senderChangeAddress, BigInt(changeSats), scureNetwork);
    }
    else {
        // Sub-dust change goes to the miner — track it so the caller can
        // surface the realised fee accurately.
        absorbedIntoFee = changeRaw;
    }
    const finalFeeSats = args.feeSats + absorbedIntoFee;
    // Hard post-build asserts.
    if (tx.lockTime !== 21) {
        throw new Error(`Internal error: lockTime=${tx.lockTime}, expected 21`);
    }
    for (let i = 0; i < tx.inputsLength; i++) {
        const input = tx.getInput(i);
        // Taproot inputs deliberately omit `sighashType` so signers default
        // to SIGHASH_DEFAULT (wire-equivalent to SIGHASH_ALL on key-path
        // spends per BIP-341). Allow undefined for those; require SIGHASH_ALL
        // explicitly on every non-Taproot input.
        const isTaproot = !!input.tapInternalKey;
        if (isTaproot) {
            if (input.sighashType !== undefined && input.sighashType !== btc.SigHash.ALL) {
                throw new Error(`Internal error: input ${i} taproot sighashType=${input.sighashType}, expected undefined or SIGHASH_ALL`);
            }
            continue;
        }
        if (input.sighashType !== btc.SigHash.ALL) {
            throw new Error(`Internal error: input ${i} sighashType is not SIGHASH_ALL`);
        }
        if (input.sequence !== sequence) {
            throw new Error(`Internal error: input ${i} sequence=${input.sequence}, expected ${sequence}`);
        }
    }
    return {
        tx,
        hex: tx.hex,
        psbt: tx.toPSBT(),
        changeSats,
        finalFeeSats,
    };
}
function addInput(tx, utxo, sequence) {
    // Legacy P2PKH path: scure requires `nonWitnessUtxo` (full previous
    // tx) and does NOT accept witnessUtxo for legacy inputs. Detect via
    // the explicit nonWitnessUtxo field set by the Layer-2 adapter.
    if (utxo.nonWitnessUtxo) {
        const legacyInput = {
            txid: utxo.txid,
            index: utxo.vout,
            sequence,
            sighashType: btc.SigHash.ALL,
            nonWitnessUtxo: utxo.nonWitnessUtxo,
        };
        if (utxo.redeemScript) {
            legacyInput.redeemScript = utxo.redeemScript;
        }
        tx.addInput(legacyInput);
        return;
    }
    // SegWit family: witnessUtxo + (optional) redeemScript for P2SH-wrap
    // + (optional) tapInternalKey for Taproot key-path.
    //
    // For Taproot inputs we OMIT `sighashType`. Per BIP-341, SIGHASH_DEFAULT
    // (absent) and SIGHASH_ALL (0x01) commit to identical bytes — only the
    // signature length differs (64 vs 65 bytes; DEFAULT skips the explicit
    // flag suffix). Most wallet signers default to DEFAULT for Taproot and
    // some (Alby's bitcoinjs-lib-based signer) REJECT an explicit
    // SIGHASH_ALL on Taproot inputs because their whitelist requires
    // `allowedSighashTypes` to be passed to opt in, and not every wallet
    // exposes that knob. Omitting the field lets the signer pick its
    // default; the wire-format commitment is identical.
    const isTaproot = !!utxo.tapInternalKey;
    const inputBase = {
        txid: utxo.txid,
        index: utxo.vout,
        sequence,
        witnessUtxo: {
            script: utxo.scriptPubKey,
            amount: BigInt(utxo.value),
        },
    };
    if (!isTaproot) {
        inputBase.sighashType = btc.SigHash.ALL;
    }
    if (utxo.redeemScript) {
        inputBase.redeemScript = utxo.redeemScript;
    }
    if (utxo.tapInternalKey) {
        inputBase.tapInternalKey = utxo.tapInternalKey;
    }
    tx.addInput(inputBase);
}
//# sourceMappingURL=cat21-mint.helper.js.map