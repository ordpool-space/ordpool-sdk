import * as btc from '@scure/btc-signer';

import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { Network, toScureNetwork } from '../network';

/**
 * Layer-1 builder for the inscribe **commit** transaction.
 *
 * Construction outline:
 *
 *   1. The reveal will spend a P2TR output whose taptree has TWO
 *      leaves:
 *        - Leaf 0 (envelope): the inscription tapscript built by
 *          `buildInscriptionEnvelope`. Signed by the ephemeral key
 *          during reveal. Used once, then irrelevant.
 *        - Leaf 1 (recovery): `<userPubkeyXOnly> OP_CHECKSIG`.
 *          Signed by the user's own wallet. Provides the
 *          "stuck-commit" sweep path documented in the plan.
 *      Internal key is the BIP-341 NUMS point
 *      (`btc.TAPROOT_UNSPENDABLE_KEY`) so the key-path spend is
 *      provably unspendable — both leaves are the only spend paths.
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
   * 32-byte x-only public key of the user's payment-side wallet.
   * Encoded into leaf-1 of the taptree as `<pubkey> OP_CHECKSIG` so
   * the user can sweep the commit output back if the reveal never
   * lands (lost reveal hex, page closed mid-flow, fee market spike).
   */
  userRecoveryPubkeyXonly: Uint8Array;
  /** Commit-tx fee in sats (built by the fee helper at Layer 3). */
  commitFeeSats: number;
  /** Reveal-tx fee in sats (reserved in commit output 0 for the reveal to pay). */
  revealFeeReserveSats: number;
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
    /** Internal key actually written to the output (always NUMS — provably unspendable). */
    internalKey: Uint8Array;
    /**
     * scure's tapLeafScript array, indexed by leaf. The envelope leaf is
     * at index 0; the recovery leaf at index 1. The reveal builder passes
     * `[tapLeafScript[0]]` to its input to spend via the envelope.
     */
    tapLeafScript: NonNullable<btc.P2TROut['tapLeafScript']>;
  };
  /** Change amount on output 1; 0 when sub-dust (absorbed into the fee). */
  changeSats: number;
}

/**
 * Builds the leaf-1 recovery tapscript: `<userPubkeyXonly> OP_CHECKSIG`.
 * 34 bytes total (32-byte push + push prefix + opcode).
 */
function buildRecoveryLeafScript(userPubkeyXonly: Uint8Array): Uint8Array {
  if (userPubkeyXonly.length !== 32) {
    throw new Error(`userRecoveryPubkeyXonly must be 32 bytes; got ${userPubkeyXonly.length}`);
  }
  return btc.Script.encode([userPubkeyXonly, 'CHECKSIG'] as never);
}

export function buildInscribeCommitPsbt(args: InscribeCommitArgs): InscribeCommitResult {
  if (args.commitFeeSats < 0) throw new Error('commitFeeSats must be non-negative');
  if (args.revealFeeReserveSats < 0) throw new Error('revealFeeReserveSats must be non-negative');

  const scureNetwork = toScureNetwork(args.network);
  const postageSats = INSCRIBE_POSTAGE_SATS;
  const commitOutputValueSats = postageSats + args.revealFeeReserveSats;

  // 2-leaf taptree: envelope leaf + recovery leaf.
  const recoveryScript = buildRecoveryLeafScript(args.userRecoveryPubkeyXonly);
  const tree: btc.TaprootScriptList = [
    { script: args.envelopeScript },
    { script: recoveryScript },
  ];
  // allowUnknownOutputs=true because the envelope tapscript isn't
  // a pattern scure recognises (it's `<pubkey> CHECKSIG OP_FALSE
  // OP_IF "ord" ... OP_ENDIF`, which is unique to ordinals). The
  // recovery leaf would be recognised as p2pk-style but we set the
  // flag once for both leaves.
  const commitP2tr = btc.p2tr(btc.TAPROOT_UNSPENDABLE_KEY, tree, scureNetwork, true);

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
      internalKey: btc.TAPROOT_UNSPENDABLE_KEY,
      tapLeafScript: commitP2tr.tapLeafScript,
    },
    changeSats,
  };
}
