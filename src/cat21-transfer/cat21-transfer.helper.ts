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
   * Funding UTXOs that pay the miner fee. GOLDEN RULE: the cat UTXO is
   * preserved intact (output 0 = catUtxo.value) and NEVER pays the fee, so
   * funding must cover at least `feeSats`. Empty funding is only valid when
   * `feeSats` is 0 (which won't relay) — in practice always non-empty.
   */
  fundingInputs: ReadonlyArray<Cat21TransferFundingInput>;
  destinations: Cat21TransferDestinations;
  /** Miner fee in sats. Caller computes from intended feeRate × vsize estimate. */
  feeSats: number;
}

export interface BuildCat21TransferResult {
  /** Raw hex of the unsigned tx. */
  hex: string;
  /** Raw PSBT bytes. */
  psbt: Uint8Array;
  /** Total funding input value (sum of fundingInputs.value). */
  fundingInputTotalSats: number;
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
 *   Input 0  — cat-bearing UTXO. Passes through UNCHANGED to output 0
 *              (FIFO: its first sat, the cat, lands at output 0's first sat).
 *   Input 1+ — funding UTXOs that pay the miner fee.
 *   Output 0 — recipient address, `catUtxo.value` sats: the WHOLE cat UTXO,
 *              preserved intact (golden rule — never resized). Cat lands here.
 *   Output 1 — funding change (absorbed into fee when sub-dust).
 *
 * Hard invariants (asserted): lockTime=21, per-wallet sequence,
 * every input SIGHASH_ALL. Coin selection is the caller's job.
 */
export function buildCat21TransferPsbt(args: BuildCat21TransferArgs): BuildCat21TransferResult {
  // GOLDEN RULE (transfer): we do NOT change the size of the cat UTXO. The
  // whole cat-bearing UTXO travels intact to the recipient — output 0 =
  // catUtxo.value — so every sat on it stays together under ordinal theory.
  // 546 is NOT used here; that is the MINT's fresh-cat postage only (the one
  // time we create a cat UTXO from scratch). The miner fee is paid by
  // SEPARATE funding inputs, never by shrinking the cat; the funding change
  // follows mint semantics (above dust -> sender, sub-dust -> absorbed into
  // the fee as a miner tip). See SDK CLAUDE.md "cat UTXO size" golden rule.
  const catOutputSats = args.catUtxo.value;
  if (args.feeSats < 0) throw new Error('feeSats must be non-negative');

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

  // Output 0: recipient gets the WHOLE cat UTXO at its real size (golden
  // rule: never resize). The cat ordinal travels here via FIFO; lockTime=21
  // mints a bonus cat onto the same first sat in the same tx.
  tx.addOutputAddress(args.destinations.recipientAddress, BigInt(catOutputSats), scureNetwork);

  // Change comes from the FUNDING only: funding - fee. The cat's sats all
  // went to output 0 untouched, so the fee is paid entirely by the funding
  // inputs, which must therefore cover at least the fee.
  const changeRaw = fundingInputTotalSats - args.feeSats;
  if (changeRaw < 0) {
    throw new Error(
      `Transfer funding insufficient: funding ${fundingInputTotalSats} sats < fee ${args.feeSats} sats. ` +
      `The cat UTXO (${catOutputSats} sats) is preserved intact and never pays the fee.`
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
    changeSats,
    finalFeeSats,
  };
}

