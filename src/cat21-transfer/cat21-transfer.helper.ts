import * as btc from '@scure/btc-signer';

import { CAT21_LOCK_TIME, assertCat21LockTime } from '../cat21-protocol/cat21-lock-time';
import { Network, toScureNetwork } from '../network';
import { CAT21_WALLET_INPUT_SEQUENCE } from '../cat21-protocol/cat21-sequence';
import { getMinimumUtxoSize } from '../cat21-script/address-format';
import { addCat21Input } from '../cat21-script/prepare-cat21-input';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  Cat21TransferCatInput,
  Cat21TransferDestinations,
  Cat21TransferFundingInput,
} from './cat21-transfer.types';

/**
 * Dust threshold for the change output. 546 sats is the conservative
 * cross-address-type floor (taproot 330, segwit 294, p2sh 540 — 546
 * clears them all).
 */
export const CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS = 546;

/**
 * Arguments for `buildCat21TransferPsbt`.
 *
 * Coin selection is the caller's responsibility. The builder structures
 * the PSBT and pins the protocol invariants; it does NOT pick UTXOs,
 * fetch them, or compute fees.
 */
export interface BuildCat21TransferArgs {
  /**
   * The signing wallet type. Currently unused for sequence-picking:
   * transfers ship `sequence = 0xfffffffd` (RBF on) for EVERY wallet
   * (see `cat21-sequence.ts`). Unlike a mint, the cat is already on
   * chain, so a third-party accelerate UI that RBF-replaces this tx
   * only risks a missed bonus mint, not a cat loss — not worth
   * degrading fee-bump UX to prevent. Kept for API symmetry with the
   * mint and offer builders.
   */
  walletType: KnownOrdinalWalletType;
  network: Network;
  catUtxo: Cat21TransferCatInput;
  /**
   * Funding UTXOs. By default (PRESERVE — `targetPostageSats` omitted) the cat
   * UTXO is never touched for the fee, so funding must cover at least
   * `feeSats`. With `targetPostageSats` set: GROW (target > catUtxo.value)
   * funding covers `(target − catUtxo.value) + feeSats`; SHRINK
   * (target < catUtxo.value) lets the cat's own freed surplus cover the fee,
   * so funding may be empty when `catUtxo.value − target ≥ feeSats`.
   */
  fundingInputs: ReadonlyArray<Cat21TransferFundingInput>;
  destinations: Cat21TransferDestinations;
  /** Miner fee in sats. Caller computes from intended feeRate × vsize estimate. */
  feeSats: number;
  /**
   * OPTIONAL output-0 size (the recipient's cat UTXO). Omitted ⇒ PRESERVE:
   * output 0 = `catUtxo.value`, the golden-rule default (never resize; fee
   * from separate funding). When set it is an EXPLICIT opt-in to resize:
   *   - `> catUtxo.value` ⇒ **GROW**: pad the output up (funding provides the
   *     extra sats + fee). Rescues a sub-dust cat mined out-of-band below the
   *     dust limit to a relay-standard size, and provisions a cold-wallet cat
   *     with padding so it can be moved once later without co-funding.
   *   - `< catUtxo.value` ⇒ **SHRINK**: trim the output; the freed surplus
   *     (`catUtxo.value − target`) self-funds the fee (one-in/one-out when it
   *     covers the fee, else co-funded by `fundingInputs`). Structurally
   *     matches ord `wallet send --postage <target>` (except `nLockTime=21`).
   * A set value must clear the recipient address's dust floor (a resized
   * output below dust would not relay); the builder throws otherwise.
   */
  targetPostageSats?: number;
}

export interface BuildCat21TransferResult {
  /** Raw hex of the unsigned tx. */
  hex: string;
  /** Raw PSBT bytes. */
  psbt: Uint8Array;
  /** Total funding input value (sum of fundingInputs.value). */
  fundingInputTotalSats: number;
  /**
   * Output-0 size actually emitted (the recipient's cat UTXO): `catUtxo.value`
   * when preserving (default), or `targetPostageSats` when grown/shrunk.
   */
  catOutputSats: number;
  /** Change output value (0 when sub-dust; absorbed into fee). */
  changeSats: number;
  /**
   * Actual miner fee in sats — `feeSats + absorbedSubDustChange`. When the
   * funding change is sub-dust it is absorbed into the fee (miner tip);
   * callers reporting the realised fee should use this, not the input
   * `feeSats`. Mirrors the mint's `finalFeeSats`.
   */
  finalFeeSats: number;
}

/**
 * Builds the unsigned CAT-21 transfer PSBT.
 *
 * Every cat-touching tx we build is structurally a CAT-21 mint:
 * `lockTime=21` re-mints a fresh cat onto the same ordinal that
 * already carries the original — a single ordinal can carry multiple
 * cats. The value `21` is a protocol marker (block 21 mined in 2009),
 * no consensus meaning.
 *
 * Structure:
 *   Input 0  — cat-bearing UTXO. FIFO: its first sat, the cat, lands at
 *              output 0's first sat.
 *   Input 1+ — funding UTXOs.
 *   Output 0 — recipient address, `catOutputSats` sats (= `catUtxo.value` by
 *              default = PRESERVE; = `targetPostageSats` when grown/shrunk).
 *   Output 1 — change (absorbed into fee when sub-dust).
 *
 * Hard invariants (asserted): lockTime=21, per-wallet sequence,
 * every input SIGHASH_ALL. Coin selection is the caller's job.
 */
export function buildCat21TransferPsbt(args: BuildCat21TransferArgs): BuildCat21TransferResult {
  // GOLDEN RULE default: PRESERVE the cat UTXO — output 0 = catUtxo.value, so
  // every sat stays together (ordinal theory) and the fee comes from SEPARATE
  // funding. `targetPostageSats` is the explicit opt-in to resize: GROW
  // (target > value) has funding pad the output + pay the fee; SHRINK
  // (target < value) lets the cat's freed surplus self-fund the fee. 546 is
  // never used here (that is the MINT's fresh-cat postage). See SDK CLAUDE.md
  // "cat UTXO size" golden rule + the grow/shrink table.
  if (args.feeSats < 0) throw new Error('feeSats must be non-negative');
  const catOutputSats = args.targetPostageSats ?? args.catUtxo.value;
  if (catOutputSats <= 0) throw new Error('targetPostageSats must be positive');
  // A resized output (explicit targetPostageSats) must clear the recipient's
  // dust floor or the tx won't relay. PRESERVE (omitted) is exempt: a caller
  // preserving a sub-dust cat knows it needs out-of-band broadcast (or a GROW).
  if (args.targetPostageSats !== undefined) {
    let recipientDust: number;
    try {
      recipientDust = getMinimumUtxoSize(args.destinations.recipientAddress);
    } catch {
      recipientDust = CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS;
    }
    if (catOutputSats < recipientDust) {
      throw new Error(
        `targetPostageSats ${catOutputSats} is below the recipient dust floor ${recipientDust}; ` +
        `a resized output below dust would not relay`
      );
    }
  }

  const scureNetwork = toScureNetwork(args.network);
  // RBF-on for every wallet on transfers. The mint-only RBF-off policy
  // (`resolveCat21MintInputSequence`) does NOT apply here: the cat is
  // already on chain, so a third-party wallet's accelerate UI dropping
  // `lockTime=21` on an RBF replacement only loses the bonus mint, not
  // the cat itself. Third-party wallets stuck at old fees CAN bump. See
  // cat21-sequence.ts docstring for the full rationale.
  const sequence = CAT21_WALLET_INPUT_SEQUENCE;

  const tx = new btc.Transaction({
    lockTime: CAT21_LOCK_TIME,
    allowLegacyWitnessUtxo: true,
    disableScriptCheck: true,
  });

  // Input 0: the cat-bearing UTXO.
  addCat21Input(tx, args.catUtxo, sequence);

  // Input 1..N: funding UTXOs (may be empty).
  let fundingInputTotalSats = 0;
  for (const funding of args.fundingInputs) {
    fundingInputTotalSats += funding.value;
    addCat21Input(tx, funding, sequence);
  }

  // Output 0: the recipient's cat UTXO at `catOutputSats` (= catUtxo.value by
  // default = PRESERVE; = targetPostageSats when grown/shrunk). The cat
  // ordinal travels here via FIFO; lockTime=21 mints a bonus cat on the same
  // first sat in the same tx.
  tx.addOutputAddress(args.destinations.recipientAddress, BigInt(catOutputSats), scureNetwork);

  // Conservation: cat value + funding = output 0 + change + fee, so
  //   change = catUtxo.value + funding − catOutputSats − fee.
  //   PRESERVE (catOutputSats = value): change = funding − fee.
  //   GROW    (catOutputSats > value): change = funding − (catOutputSats − value) − fee.
  //   SHRINK  (catOutputSats < value): change = (value − catOutputSats) + funding − fee
  //                                    (the cat's freed surplus self-funds the fee).
  const changeRaw = args.catUtxo.value + fundingInputTotalSats - catOutputSats - args.feeSats;
  if (changeRaw < 0) {
    throw new Error(
      `Transfer funding insufficient: cat ${args.catUtxo.value} + funding ${fundingInputTotalSats} sats ` +
      `< output ${catOutputSats} + fee ${args.feeSats} sats required`
    );
  }
  // Per-address-type dust floor for the change output. The
  // CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS constant (546) is the
  // conservative cross-type floor and stays in place as a defence-
  // in-depth fallback if getMinimumUtxoSize ever fails to classify
  // the address; the per-address value is preferred so P2TR (330)
  // and P2WPKH (294) change amounts in [dust, 546) actually get
  // emitted instead of being silently absorbed into the miner fee.
  let changeDustLimit: number;
  try {
    changeDustLimit = getMinimumUtxoSize(args.destinations.senderChangeAddress);
  } catch {
    changeDustLimit = CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS;
  }
  let changeSats = 0;
  let absorbedIntoFee = 0;
  if (changeRaw >= changeDustLimit) {
    changeSats = changeRaw;
    tx.addOutputAddress(args.destinations.senderChangeAddress, BigInt(changeSats), scureNetwork);
  } else {
    // Sub-dust change -> miner tip (same as the mint).
    absorbedIntoFee = changeRaw;
  }
  const finalFeeSats = args.feeSats + absorbedIntoFee;

  // Hard post-build asserts. SIGHASH_ALL commits to lockTime + sequence
  // across the whole tx, so once any input signs, the 21 marker AND
  // the chosen RBF semantics are cryptographically locked.
  assertCat21LockTime(tx.lockTime);
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    // Taproot inputs intentionally omit sighashType (see addCat21Input);
    // SIGHASH_DEFAULT and SIGHASH_ALL are wire-equivalent for key-path
    // spends per BIP-341.
    const isTaproot = !!input.tapInternalKey;
    if (!isTaproot && input.sighashType !== btc.SigHash.ALL) {
      throw new Error(`Internal error: input ${i} sighashType is not SIGHASH_ALL`);
    }
    if (input.sequence !== sequence) {
      throw new Error(
        `Internal error: input ${i} sequence=${input.sequence}, expected ${sequence}`
      );
    }
  }

  return {
    hex: tx.hex,
    psbt: tx.toPSBT(),
    fundingInputTotalSats,
    catOutputSats,
    changeSats,
    finalFeeSats,
  };
}

