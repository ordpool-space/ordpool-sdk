import * as btc from '@scure/btc-signer';

import { getMinimumUtxoSize } from '../cat21-script/address-format';

import { CAT21_LOCK_TIME, assertCat21LockTime } from '../cat21-protocol/cat21-lock-time';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { resolveCat21MintInputSequence } from '../cat21-protocol/cat21-sequence';
import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';

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
 *          `resolveCat21MintInputSequence(walletType)`: 0xfffffffd for
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
 * Chosen because it is the cheapest value that relays everywhere, not
 * because of any rule that cats are 546. Nothing here asserts a size.
 */
export const INSCRIBE_POSTAGE_SATS = CAT21_POSTAGE_SATS;

/**
 * The postage an inscription actually gets: the caller's choice, or 546.
 *
 * ord's equivalent is `--postage <AMOUNT>`, default 10000. Ours defaults to
 * 546 on purpose, because it is cheaper and is the common denominator most
 * tools use; ord's 10000 would cost every user 9454 sats of padding they did
 * not ask for. The OPTION exists so someone who wants more padding can have
 * it, and so a batch can match ord byte for byte at any size.
 *
 * Resolved ONCE per inscribe and passed to every builder. The reveal derives
 * its fee as `commitOutput - postage - tip`, so a commit and a reveal that
 * disagreed on postage would silently mis-state the fee rather than fail.
 */
export function resolveInscribePostage(postageSats: number | undefined): number {
  if (postageSats === undefined) return INSCRIBE_POSTAGE_SATS;
  if (!Number.isInteger(postageSats) || postageSats <= 0) {
    throw new Error(`postageSats must be a positive integer; got ${postageSats}`);
  }
  return postageSats;
}

/**
 * The UTXO holding the sat an inscription goes on, spent as the commit's
 * input 0 ahead of the funding input. Its sats never pay a fee and never go
 * to the payment change: the ones in front of the chosen sat return to
 * `address` as a padding output (ord's `align_outgoing`), and the ones after
 * the commit output's share return to `address` as a remainder output. The
 * funding input pays the fee and whatever the commit output still needs.
 *
 * P2TR key-path only (an ordinals address), so its witness is exactly one
 * 64-byte Schnorr signature and the fee is exact before the wallet signs.
 */
export interface InscribeSatSource {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: Uint8Array;
  /** x-only internal key of the P2TR output (the ordinals address's key). */
  tapInternalKey: Uint8Array;
  /** The address the UTXO sits at; padding and remainder return here. */
  address: string;
  /** Offset of the chosen sat within the UTXO. */
  offset: number;
}

/**
 * The sats of a `satSource` UTXO after the chosen sat that the commit output
 * does not take, which return to its address. Below that address's dust
 * limit they cannot be their own output: the commit output takes them and
 * the inscription's postage grows by them (see `createInscribeTransactions`).
 */
export function satSourceRemainder(satSource: InscribeSatSource, commitOutputValueSats: number): number {
  return Math.max(0, satSource.value - satSource.offset - commitOutputValueSats);
}

export interface InscribeCommitArgs {
  /** Postage for the inscription output; see `resolveInscribePostage`. Default 546. */
  postageSats?: number;
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
  /**
   * Which wallet will sign the commit PSBT. Drives the funding
   * input's sequence number via `resolveCat21MintInputSequence`:
   *   - `cat21wallet`: 0xfffffffd (RBF-allowed; our wallet preserves
   *     `lockTime=21` through any replacement).
   *   - any other wallet (default): 0xfffffffe (non-RBF; locks
   *     third-party accelerate UIs out of touching the marker,
   *     defending against the 2024 Xverse incident where an
   *     accelerator dropped `lockTime=21` and burned a CAT-21 mint).
   *
   * Defaults to a non-cat21wallet sentinel so any standalone caller
   * (regtest specs, third-party SDK consumers) gets the safer
   * non-RBF sequence without having to know about the rule.
   */
  walletType?: KnownOrdinalWalletType;
  /** Per-address-type change dust limit; below this the change is absorbed into the fee. */
  changeDustLimitSats?: number;
  /**
   * Inscribe onto the sat at this offset within the funding input, ord's
   * `--satpoint <funding outpoint>:<offset>`. As ord does
   * (transaction_builder.rs, `align_outgoing`), a padding output of exactly
   * `satOffset` sats goes first, to `senderChangeAddress`, so the chosen
   * sat is the first sat of the commit output, which then sits at vout 1.
   * The padding must clear that address's dust limit; ord would top it up
   * with further inputs, which this one-input commit does not take.
   * Default 0: the funding input's first sat, no padding output.
   */
  satOffset?: number;
  /**
   * The UTXO holding the sat to inscribe onto, when it is not the funding
   * UTXO: ord's `--satpoint` on a UTXO other than the one paying (the usual
   * rare-sat case, the sat kept at the ordinals address). See
   * {@link InscribeSatSource}. Excludes `satOffset`, which is the same thing
   * inside the funding UTXO.
   */
  satSource?: InscribeSatSource;
  /**
   * The sats the commit output carries for the reveal's inscription outputs,
   * replacing `postageSats`. 0 when the reveal's own inputs fund them (ord's
   * `satpoints` batch mode, where the commit pays only the reveal fee).
   */
  commitPostageSats?: number;
  network: Network;
}

export interface InscribeCommitResult {
  /** Unsigned PSBT bytes ready for the user's wallet to sign. */
  commitPsbt: Uint8Array;
  /** Bech32m P2TR address the reveal will spend from. */
  commitAddress: string;
  /** scriptPubKey bytes of the commit output (same script the reveal references). */
  commitOutputScript: Uint8Array;
  /**
   * Sat value the commit places at output 0. Equals
   * `postage + revealFeeReserveSats + (tipValueSats ?? 0)`. Funds
   * the reveal's recipient output + optional tip output + reveal
   * miner fee in a single P2TR commit.
   */
  commitOutputValueSats: number;
  /** Index of the commit output: 0, or 1 behind a padding output. */
  commitVout: number;
  /** Index of the funding input the payment wallet signs: 0, or 1 behind a `satSource`. */
  fundingInputIndex: number;
  /** Sats returned to the `satSource` address after the commit output; 0 without one. */
  remainderSats: number;
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
  /** Change amount, after the commit output; 0 when sub-dust (absorbed into the fee). */
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
  if (args.commitPostageSats !== undefined && (!Number.isInteger(args.commitPostageSats) || args.commitPostageSats < 0)) {
    throw new Error(`commitPostageSats must be a non-negative integer; got ${args.commitPostageSats}`);
  }
  const postageSats = args.commitPostageSats ?? resolveInscribePostage(args.postageSats);
  const tipValueSats = args.tipValueSats ?? 0;
  let commitOutputValueSats = postageSats + args.revealFeeReserveSats + tipValueSats;
  // A satSource remainder below its address's dust limit cannot be its own
  // output; the commit output takes it (createInscribeTransactions then
  // raises the postage by it, so the reveal hands it to the inscription).
  if (args.satSource !== undefined) {
    const remainder = satSourceRemainder(args.satSource, commitOutputValueSats);
    if (remainder > 0 && remainder < getMinimumUtxoSize(args.satSource.address)) {
      commitOutputValueSats += remainder;
    }
  }

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
  const tx = new btc.Transaction({ allowUnknownOutputs: false, lockTime: CAT21_LOCK_TIME });
  // Default to a non-cat21wallet sentinel so the sequence resolves to
  // the safer non-RBF value (0xfffffffe). Standalone callers get the
  // correct behaviour without having to learn the per-wallet rule.
  //
  // NOTE: this is a DIFFERENT reason for RBF-off than the mint case.
  // On mint, a third-party accelerate would drop `lockTime=21` and
  // kill the mint (no cat is produced). On inscribe commit, an RBF
  // replacement changes the commit's inputs → its txid changes → the
  // pre-built reveal (which
  // references the SIMULATION commit txid) becomes invalid and the
  // postage locks in an output nobody can spend (the ephemeral reveal
  // key is not returned to the caller). Both cases warrant RBF-off
  // for third-party wallets; the "mint" in the resolver's name refers
  // to the CAT-flow rule, but the same value happens to protect us here.
  const sequence = resolveCat21MintInputSequence(args.walletType ?? KnownOrdinalWalletType.xverse);

  // Funding input shape mirrors the cat21 mint adapter: witnessUtxo
  // for SegWit, nonWitnessUtxo for P2PKH legacy, plus per-address-
  // type optional fields.
  const inputBase: btc.TransactionInputUpdate = {
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
  } else {
    inputBase.sighashType = btc.SigHash.ALL;
  }
  if (args.fundingInput.redeemScript) {
    inputBase.redeemScript = args.fundingInput.redeemScript;
  }
  if (args.fundingInput.nonWitnessUtxo) {
    inputBase.nonWitnessUtxo = args.fundingInput.nonWitnessUtxo;
  }
  // The input holding the chosen sat comes first: the satSource when given,
  // otherwise the funding input itself.
  const source = args.satSource;
  if (source !== undefined) {
    if ((args.satOffset ?? 0) !== 0) {
      throw new Error('pass satOffset (a sat in the funding UTXO) or satSource, not both');
    }
    if (source.tapInternalKey.length !== 32) {
      throw new Error('satSource must be a P2TR UTXO with its 32-byte x-only internal key');
    }
    tx.addInput({
      txid: source.txid,
      index: source.vout,
      sequence,
      witnessUtxo: { script: source.scriptPubKey, amount: BigInt(source.value) },
      tapInternalKey: source.tapInternalKey,
    });
  }
  tx.addInput(inputBase);

  // Padding output: the sats in front of the chosen sat, so it becomes the
  // first sat of the commit output (ord's align_outgoing).
  const satOffset = source?.offset ?? args.satOffset ?? 0;
  const satInputValue = source?.value ?? args.fundingInput.value;
  const paddingAddress = source?.address ?? args.senderChangeAddress;
  if (!Number.isInteger(satOffset) || satOffset < 0) {
    throw new Error(`satOffset must be a non-negative integer; got ${satOffset}`);
  }
  if (satOffset >= satInputValue) {
    throw new Error(`satOffset ${satOffset} is outside the ${satInputValue}-sat ${source ? 'sat source' : 'funding input'}`);
  }
  if (satOffset > 0) {
    const paddingDust = getMinimumUtxoSize(paddingAddress);
    if (satOffset < paddingDust) {
      throw new Error(
        `satOffset ${satOffset} would make a padding output below the ${paddingDust}-sat dust limit ` +
        `of ${paddingAddress}; ord pads it with another input, which this commit does not take`,
      );
    }
    tx.addOutputAddress(paddingAddress, BigInt(satOffset), scureNetwork);
  }
  const commitVout = satOffset > 0 ? 1 : 0;

  // The commit P2TR output. The reveal will spend this.
  tx.addOutput({
    script: commitP2tr.script,
    amount: BigInt(commitOutputValueSats),
  });

  // The satSource's sats after the commit output's share go back to its own
  // address, never to the payment change.
  // (A sub-dust remainder was already taken by the commit output above.)
  let remainderSats = 0;
  if (source !== undefined) {
    remainderSats = satSourceRemainder(source, commitOutputValueSats);
    if (remainderSats > 0) {
      tx.addOutputAddress(source.address, BigInt(remainderSats), scureNetwork);
    }
  }

  // Change to the user, after the commit output, when above dust. The
  // funding input covers the fee and whatever part of the commit output the
  // chosen sat's input does not.
  const changeDustLimit = args.changeDustLimitSats ?? postageSats;
  const fromFunding = source !== undefined
    ? Math.max(0, commitOutputValueSats - (source.value - satOffset))
    : satOffset + commitOutputValueSats;
  const calculatedChange = args.fundingInput.value - fromFunding - args.commitFeeSats;
  if (calculatedChange < 0) {
    throw new Error(
      `Funding insufficient: input=${args.fundingInput.value}, padding=${satOffset}, ` +
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
  if (tx.getOutput(commitVout).amount !== BigInt(commitOutputValueSats)) {
    throw new Error(`Internal error: commit output ${commitVout} amount drifted`);
  }
  assertCat21LockTime(tx.lockTime);
  for (let i = 0; i < tx.inputsLength; i++) {
    if (tx.getInput(i).sequence !== sequence) {
      throw new Error(`Internal error: input ${i} sequence=${tx.getInput(i).sequence}, expected ${sequence}`);
    }
  }

  return {
    commitPsbt: tx.toPSBT(0),
    commitAddress,
    commitOutputScript: commitP2tr.script,
    commitOutputValueSats,
    commitVout,
    fundingInputIndex: source !== undefined ? 1 : 0,
    remainderSats,
    taproot: {
      internalKey: args.ephemeralPubkeyXonly,
      tapLeafScript: commitP2tr.tapLeafScript,
    },
    changeSats,
  };
}
