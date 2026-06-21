import * as btc from '@scure/btc-signer';

import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { Network, toScureNetwork } from '../network';

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

export interface InscribeCommitArgs {
  /** Funding UTXO the user's wallet will sign. */
  fundingInput: {
    txid: string;
    vout: number;
    value: number;
    scriptPubKey: Uint8Array;
    /** Set on P2TR funding inputs. Same shape as the cat21 mint adapter. */
    tapInternalKey?: Uint8Array;
    /** Set on P2SH-wrapped funding (Xverse Nested SegWit etc.). */
    redeemScript?: Uint8Array;
    /** Set on legacy P2PKH funding. */
    nonWitnessUtxo?: Uint8Array;
  };
  /** Address the user's change returns to (taproot output of the funding wallet). */
  senderChangeAddress: string;
  /** Tapscript bytes for the envelope leaf (output of `buildInscriptionEnvelope`). */
  envelopeScript: Uint8Array;
  /**
   * 32-byte x-only ephemeral public key. Doubles as:
   *   - The first push inside the envelope script (`<pubkey>
   *     CHECKSIG OP_FALSE OP_IF "ord" …`).
   *   - The taproot internal key of the commit output.
   * Holding the matching private key authorises any reveal-tx
   * shape the consumer wants to build (default reveal, redirect,
   * RBF, recover-to-self, bundle).
   */
  ephemeralPubkeyXonly: Uint8Array;
  /** Commit-tx fee in sats (built by the fee helper at Layer 3). */
  commitFeeSats: number;
  /** Reveal-tx fee in sats (reserved in commit output 0 for the reveal to pay). */
  revealFeeReserveSats: number;
  /**
   * Optional tip-output amount in sats reserved on the commit output
   * (in addition to postage + revealFeeReserve). The tip output itself
   * lives on the reveal tx at vout[1]; this is just the bookkeeping
   * the commit needs to fund it.
   *
   * When set, `commitOutputValueSats = postage + revealFeeReserve +
   * tipValueSats`; when omitted the commit output sizes exactly as
   * before. Must be a non-negative integer.
   */
  tipValueSats?: number;
  /** Per-address-type change dust limit; below this the change is absorbed into the fee. */
  changeDustLimitSats?: number;
  network: Network;
}

export interface InscribeCommitResult {
  /** Unsigned PSBT bytes ready for the user's wallet to sign. */
  commitPsbt: Uint8Array;
  /** Bech32m P2TR address the reveal will spend from. */
  commitAddress: string;
  /** scriptPubKey bytes of the commit output (same script the reveal references). */
  commitOutputScript: Uint8Array;
  /** Sat value the commit places at output 0 (postage + revealFeeReserve). */
  commitOutputValueSats: number;
  /** Taptree metadata the reveal builder needs to construct its spending witness. */
  taproot: {
    /** Taproot internal key actually written to the output (the ephemeral pubkey). */
    internalKey: Uint8Array;
    /**
     * scure's tapLeafScript array — single entry, for the envelope leaf.
     * The reveal builder passes this straight to the script-path reveal;
     * a key-path reveal doesn't need it.
     */
    tapLeafScript: NonNullable<btc.P2TROut['tapLeafScript']>;
  };
  /** Change amount on output 1; 0 when sub-dust (absorbed into the fee). */
  changeSats: number;
}

export function buildInscribeCommitPsbt(args: InscribeCommitArgs): InscribeCommitResult {
  if (args.commitFeeSats < 0) throw new Error('commitFeeSats must be non-negative');
  if (args.revealFeeReserveSats < 0) throw new Error('revealFeeReserveSats must be non-negative');
  if (args.tipValueSats !== undefined && args.tipValueSats < 0) {
    throw new Error('tipValueSats must be non-negative');
  }
  if (args.ephemeralPubkeyXonly.length !== 32) {
    throw new Error(`ephemeralPubkeyXonly must be 32 bytes; got ${args.ephemeralPubkeyXonly.length}`);
  }

  const scureNetwork = toScureNetwork(args.network);
  const postageSats = INSCRIBE_POSTAGE_SATS;
  const tipValueSats = args.tipValueSats ?? 0;
  const commitOutputValueSats = postageSats + args.revealFeeReserveSats + tipValueSats;

  // Single envelope leaf; ephemeral key as the taproot internal key.
  // Matches ord's `TaprootBuilder::new().add_leaf(0, reveal_script)
  // .finalize(&secp256k1, public_key)` (plan.rs:378-382).
  //
  // allowUnknownOutputs=true because the envelope tapscript isn't a
  // pattern scure recognises (`<pubkey> CHECKSIG OP_FALSE OP_IF
  // "ord" ... OP_ENDIF` is ord-specific).
  const tree: btc.TaprootScriptList = [{ script: args.envelopeScript }];
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
  const inputBase: btc.TransactionInputUpdate = {
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
  } else {
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
  const calculatedChange =
    args.fundingInput.value - commitOutputValueSats - args.commitFeeSats;
  if (calculatedChange < 0) {
    throw new Error(
      `Funding insufficient: input=${args.fundingInput.value}, ` +
      `commitOutput=${commitOutputValueSats}, commitFee=${args.commitFeeSats}`
    );
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
