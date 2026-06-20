import * as btc from '@scure/btc-signer';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { toScureNetwork } from '../network';
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
 *          signs)
 *        - Output 0: the commit P2TR address holding
 *          `postage + revealFeeReserve`. The reveal spends this.
 *        - Output 1 (optional): change back to the user, if the
 *          funding input has surplus above commit fee + output 0.
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
export const INSCRIBE_POSTAGE_SATS = CAT21_POSTAGE_SATS;
export function buildInscribeCommitPsbt(args) {
    if (args.commitFeeSats < 0)
        throw new Error('commitFeeSats must be non-negative');
    if (args.revealFeeReserveSats < 0)
        throw new Error('revealFeeReserveSats must be non-negative');
    if (args.ephemeralPubkeyXonly.length !== 32) {
        throw new Error(`ephemeralPubkeyXonly must be 32 bytes; got ${args.ephemeralPubkeyXonly.length}`);
    }
    const scureNetwork = toScureNetwork(args.network);
    const postageSats = INSCRIBE_POSTAGE_SATS;
    const commitOutputValueSats = postageSats + args.revealFeeReserveSats;
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
    // Build the PSBT.
    const tx = new btc.Transaction({ allowUnknownOutputs: false });
    // Funding input shape mirrors the cat21 mint adapter: witnessUtxo
    // for SegWit, nonWitnessUtxo for P2PKH legacy, plus per-address-
    // type optional fields.
    const inputBase = {
        txid: args.fundingInput.txid,
        index: args.fundingInput.vout,
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