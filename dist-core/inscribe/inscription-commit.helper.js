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
exports.INSCRIBE_POSTAGE_SATS = void 0;
exports.buildInscribeCommitPsbt = buildInscribeCommitPsbt;
const btc = __importStar(require("@scure/btc-signer"));
const cat21_postage_1 = require("../cat21-protocol/cat21-postage");
const cat21_sequence_1 = require("../cat21-protocol/cat21-sequence");
const network_1 = require("../network");
const wallet_service_types_1 = require("../wallet/wallet.service.types");
/**
 * Layer-1 builder for the inscribe **commit** transaction.
 *
 * Construction outline:
 *
 *   1. The reveal spends a P2TR output with a **single envelope leaf**.
 *      The **ephemeral key** is the taproot internal key — so the
 *      commit output has two equivalent spend paths:
 *        a. Script-path via the envelope leaf (used by the standard
 *           reveal — emits the inscription).
 *        b. Key-path via the ephemeral key (used by any redirect /
 *           RBF / recover / bundle reveal the consumer constructs
 *           after `createInscribeTransactions` returns).
 *      Same shape as Casey Rodarmor's `ord` reference client
 *      (`src/wallet/batch/plan.rs` lines 367-382). The ephemeral key
 *      doubles as a bearer instrument: whoever holds it can build
 *      any reveal-tx shape until the commit output is spent.
 *
 *   2. The commit transaction has:
 *        - 1 funding input (caller-supplied UTXO; user's wallet
 *          signs). Sequence is wallet-specific via
 *          `resolveCat21InputSequence(walletType)`: 0xfffffffd for
 *          cat21wallet (RBF allowed; our wallet preserves
 *          lockTime=21 through replacement), 0xfffffffe for every
 *          third-party wallet (RBF disabled; locks accelerate UIs
 *          out, the 2024 Xverse incident defence).
 *        - Output 0: the commit P2TR address holding
 *          `postage + revealFeeReserve + tipValueSats` (the last
 *          term only when `tipValueSats > 0` on the reveal). The
 *          reveal spends this.
 *        - Output 1 (optional): change back to the user, if the
 *          funding input has surplus above commit fee + output 0.
 *
 *   3. `nLockTime=21`: the commit qualifies as a CAT-21 mint under
 *      cat21-ord's `--index-cat21` rule. The first sat of vout[0]
 *      becomes Cat A (`<commitTxid>i0`). The reveal then spends
 *      vout[0] FIFO-style, moving Cat A to the inscription's UTXO,
 *      and the reveal itself (also `nLockTime=21`) mints Cat B
 *      (`<revealTxid>i0`) at the same satpoint. Net: two cats per
 *      inscribe, stacked on the inscription's 546-sat UTXO. The
 *      maintainer's design: "we gift the cats for free. because
 *      why not."
 *
 * Returns the unsigned commit PSBT bytes + the metadata the
 * reveal builder needs to construct the spending witness.
 */
/**
 * Canonical postage for inscriptions. Same 546-sat dust floor as
 * cat21 — keeps inscription UTXOs fungible across address types
 * AND matches the floor every inscriber in the OSS catalog uses.
 * See HQ rule "cat UTXO is always 546 sats, FIFO".
 */
exports.INSCRIBE_POSTAGE_SATS = cat21_postage_1.CAT21_POSTAGE_SATS;
function buildInscribeCommitPsbt(args) {
    if (args.commitFeeSats < 0)
        throw new Error('commitFeeSats must be non-negative');
    if (args.revealFeeReserveSats < 0)
        throw new Error('revealFeeReserveSats must be non-negative');
    if (args.tipValueSats !== undefined && args.tipValueSats < 0) {
        throw new Error('tipValueSats must be non-negative');
    }
    if (args.ephemeralPubkeyXonly.length !== 32) {
        throw new Error(`ephemeralPubkeyXonly must be 32 bytes; got ${args.ephemeralPubkeyXonly.length}`);
    }
    const scureNetwork = (0, network_1.toScureNetwork)(args.network);
    const postageSats = exports.INSCRIBE_POSTAGE_SATS;
    const tipValueSats = args.tipValueSats ?? 0;
    const commitOutputValueSats = postageSats + args.revealFeeReserveSats + tipValueSats;
    // Single envelope leaf; ephemeral key as the taproot internal key.
    // Matches ord's `TaprootBuilder::new().add_leaf(0, reveal_script)
    // .finalize(&secp256k1, public_key)` (plan.rs:378-382).
    //
    // allowUnknownOutputs=true because the envelope tapscript isn't a
    // pattern scure recognises (`<pubkey> CHECKSIG OP_FALSE OP_IF
    // "ord" ... OP_ENDIF` is ord-specific).
    const tree = [{ script: args.envelopeScript }];
    const commitP2tr = btc.p2tr(args.ephemeralPubkeyXonly, tree, scureNetwork, true);
    const commitAddress = commitP2tr.address;
    if (commitAddress === undefined) {
        throw new Error('Internal error: p2tr returned no address for commit output');
    }
    if (commitP2tr.tapLeafScript === undefined) {
        throw new Error('Internal error: p2tr returned no tapLeafScript for the constructed tree');
    }
    // Build the PSBT with `lockTime=21`. Every ordpool inscription is
    // ALSO a CAT-21 mint — we gift the cat for free to anyone using
    // the inscribe pipeline. cat21-ord reads `nLockTime` structurally
    // and assigns a cat to the first sat of the first output (the
    // commit's P2TR envelope output). The reveal then spends that
    // output FIFO-style, moving the cat to the inscription recipient
    // — so the cat and the inscription end up on the same sat at the
    // same address, with no extra cost to the user.
    //
    // Block 21 was mined in 2009, so the lockTime constraint is
    // trivially satisfied no matter when the tx lands. The field is
    // repurposed protocol-marker data; cat21-ord reads it structurally.
    const tx = new btc.Transaction({ allowUnknownOutputs: false, lockTime: 21 });
    // Default to a non-cat21wallet sentinel so the sequence resolves to
    // the safer non-RBF value (0xfffffffe). Standalone callers get the
    // correct behaviour without having to learn the per-wallet rule.
    const sequence = (0, cat21_sequence_1.resolveCat21InputSequence)(args.walletType ?? wallet_service_types_1.KnownOrdinalWalletType.xverse);
    // Funding input shape mirrors the cat21 mint adapter: witnessUtxo
    // for SegWit, nonWitnessUtxo for P2PKH legacy, plus per-address-
    // type optional fields.
    const inputBase = {
        txid: args.fundingInput.txid,
        index: args.fundingInput.vout,
        sequence,
        witnessUtxo: {
            script: args.fundingInput.scriptPubKey,
            amount: BigInt(args.fundingInput.value),
        },
    };
    if (args.fundingInput.tapInternalKey) {
        // Taproot key-path: SIGHASH_DEFAULT (omit), per the SDK-wide
        // BIP-341 wire-equivalent rule.
        inputBase.tapInternalKey = args.fundingInput.tapInternalKey;
    }
    else {
        inputBase.sighashType = btc.SigHash.ALL;
    }
    if (args.fundingInput.redeemScript) {
        inputBase.redeemScript = args.fundingInput.redeemScript;
    }
    if (args.fundingInput.nonWitnessUtxo) {
        inputBase.nonWitnessUtxo = args.fundingInput.nonWitnessUtxo;
    }
    tx.addInput(inputBase);
    // Output 0: commit P2TR. The reveal will spend this.
    tx.addOutput({
        script: commitP2tr.script,
        amount: BigInt(commitOutputValueSats),
    });
    // Output 1: change to the user, when above dust.
    const changeDustLimit = args.changeDustLimitSats ?? postageSats;
    const calculatedChange = args.fundingInput.value - commitOutputValueSats - args.commitFeeSats;
    if (calculatedChange < 0) {
        throw new Error(`Funding insufficient: input=${args.fundingInput.value}, ` +
            `commitOutput=${commitOutputValueSats}, commitFee=${args.commitFeeSats}`);
    }
    let changeSats = 0;
    if (calculatedChange >= changeDustLimit) {
        changeSats = calculatedChange;
        tx.addOutputAddress(args.senderChangeAddress, BigInt(changeSats), scureNetwork);
    }
    // else: change is absorbed into the miner fee (same model as cat21 mint).
    // Hard invariants (asserted before return).
    if (tx.outputsLength === 0) {
        throw new Error('Internal error: commit must have at least one output');
    }
    if (tx.getOutput(0).amount !== BigInt(commitOutputValueSats)) {
        throw new Error('Internal error: commit output 0 amount drifted');
    }
    if (tx.lockTime !== 21) {
        throw new Error(`Internal error: lockTime=${tx.lockTime}, expected 21`);
    }
    if (tx.getInput(0).sequence !== sequence) {
        throw new Error(`Internal error: input 0 sequence=${tx.getInput(0).sequence}, expected ${sequence}`);
    }
    return {
        commitPsbt: tx.toPSBT(0),
        commitAddress,
        commitOutputScript: commitP2tr.script,
        commitOutputValueSats,
        taproot: {
            internalKey: args.ephemeralPubkeyXonly,
            tapLeafScript: commitP2tr.tapLeafScript,
        },
        changeSats,
    };
}
//# sourceMappingURL=inscription-commit.helper.js.map