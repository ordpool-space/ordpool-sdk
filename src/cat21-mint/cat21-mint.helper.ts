import * as btc from '@scure/btc-signer';

import { CAT21_LOCK_TIME, assertCat21LockTime } from '../cat21-protocol/cat21-lock-time';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { Cat21PreparedInput, addCat21Input } from '../cat21-script/prepare-cat21-input';
import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { resolveCat21MintInputSequence } from '../cat21-protocol/cat21-sequence';

/**
 * Alias for {@link CAT21_POSTAGE_SATS}. The canonical constant lives in
 * `cat21-postage.ts`; this re-export exists for legacy import paths.
 */
export const CAT21_MINT_POSTAGE_SATS = CAT21_POSTAGE_SATS;

/**
 * Dust threshold for the change output. 546 sats is the conservative
 * cross-address-type floor (taproot 330, segwit 294, p2sh 540 — 546
 * clears them all).
 */
export const CAT21_MINT_CHANGE_DUST_LIMIT_SATS = 546;

/**
 * Funding UTXO that pays postage + miner fee + optional tip. Coin
 * selection is the caller's job; the builder does not select.
 *
 * Per-address-shape fields (set what applies; `prepareMintInputForWallet`
 * does this automatically):
 *   - SegWit v0 (P2WPKH): `scriptPubKey` only.
 *   - P2SH-wrapped SegWit: `scriptPubKey` + `redeemScript`.
 *   - Taproot key-path: `scriptPubKey` + `tapInternalKey`.
 *   - Legacy P2PKH: `scriptPubKey` + `nonWitnessUtxo` (full
 *     previous-tx bytes; scure requires this for legacy inputs).
 */
export type Cat21MintFundingInput = Cat21PreparedInput;

/** Output destinations of a CAT-21 mint. */
export interface Cat21MintDestinations {
  /** Where the freshly-minted cat lands. */
  recipientAddress: string;
  /** Where the funder's BTC change goes (when above dust). */
  senderChangeAddress: string;
  /** Optional developer-tip output. Skip by setting value to 0. */
  tip?: { address: string; valueSats: number };
}

export interface BuildCat21MintArgs {
  /**
   * Which wallet will sign this PSBT. Determines the input sequence:
   *   - `cat21wallet`: sequence = 0xfffffffd (RBF on; our accelerate
   *     flow preserves `lockTime=21` through replacement).
   *   - any other wallet: sequence = 0xfffffffe (RBF off; third-party
   *     accelerate UIs can't fire and drop the marker on replacement
   *     — the 2024 Xverse-incident defence).
   */
  walletType: KnownOrdinalWalletType;
  network: Network;
  fundingInput: Cat21MintFundingInput;
  destinations: Cat21MintDestinations;
  /** Miner fee in sats. Caller computes from intended feeRate × vsize estimate. */
  feeSats: number;
  /**
   * Optional dust limit for the CHANGE output. Defaults to
   * `CAT21_MINT_CHANGE_DUST_LIMIT_SATS = 546` (cross-address-type
   * conservative floor). The cat21.space orchestrator passes a
   * per-address-type value via `getMinimumUtxoSize(paymentAddress)`
   * (P2TR 330, P2WPKH 294, P2SH 540) for marginally tighter dust
   * absorption when the change goes to a Taproot address.
   *
   * NOTE: this does NOT change the cat OUTPUT postage — that's
   * always 546 (HARD RULE). Only the threshold below which the
   * change output gets absorbed into the miner fee.
   */
  changeDustLimitSats?: number;
}

export interface BuildCat21MintResult {
  /** The constructed scure Transaction (unfinalized, ready for signing). */
  tx: btc.Transaction;
  /** Raw hex of the unsigned tx. */
  hex: string;
  /** Raw PSBT bytes. */
  psbt: Uint8Array;
  /** Change output value (0 when sub-dust; absorbed into fee). */
  changeSats: number;
  /**
   * Actual miner fee in sats — this is `feeSats + absorbedSubDustChange`.
   * When the change crossed the dust limit it gets absorbed into the
   * fee here; callers that report the realised fee back to the user
   * should use this field, not the input `feeSats`.
   */
  finalFeeSats: number;
}

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
export function buildCat21MintPsbt(args: BuildCat21MintArgs): BuildCat21MintResult {
  // HARD RULE: cat output is always exactly 546 sats. The cat is born
  // at the first sat of output 0; uniform postage across mint /
  // transfer / offer means a cat UTXO is fungible across address types.
  // See SDK CLAUDE.md "cat UTXO is always 546 sats".
  const postageSats = CAT21_POSTAGE_SATS;
  if (args.feeSats < 0) throw new Error('feeSats must be non-negative');
  const tipValueSats = args.destinations.tip?.valueSats ?? 0;
  if (tipValueSats < 0) throw new Error('tip.valueSats must be non-negative');

  const scureNetwork = toScureNetwork(args.network);
  const sequence = resolveCat21MintInputSequence(args.walletType);

  const tx = new btc.Transaction({
    lockTime: CAT21_LOCK_TIME,
    allowLegacyWitnessUtxo: true,
    disableScriptCheck: true,
  });

  // Input 0: the funding UTXO. The first sat of this UTXO becomes the
  // first sat of output 0; cat21-ord mints the cat there.
  addCat21Input(tx, args.fundingInput, sequence);

  // Output 0: recipient (cat lands here).
  tx.addOutputAddress(args.destinations.recipientAddress, BigInt(postageSats), scureNetwork);

  // Output 1: optional tip.
  if (tipValueSats > 0 && args.destinations.tip) {
    tx.addOutputAddress(args.destinations.tip.address, BigInt(tipValueSats), scureNetwork);
  }

  // Change calculation. The dust threshold is the smaller of (a) the
  // builder default 546 and (b) the caller-supplied per-address-type
  // floor (cat21.space passes `getMinimumUtxoSize(paymentAddress)`).
  const changeDustLimit = args.changeDustLimitSats ?? CAT21_MINT_CHANGE_DUST_LIMIT_SATS;
  const required = postageSats + tipValueSats + args.feeSats;
  const changeRaw = args.fundingInput.value - required;
  if (changeRaw < 0) {
    throw new Error(
      `Mint funding insufficient: ${args.fundingInput.value} sats < ${required} sats required`
    );
  }
  let changeSats = 0;
  let absorbedIntoFee = 0;
  if (changeRaw >= changeDustLimit) {
    changeSats = changeRaw;
    tx.addOutputAddress(args.destinations.senderChangeAddress, BigInt(changeSats), scureNetwork);
  } else {
    // Sub-dust change goes to the miner — track it so the caller can
    // surface the realised fee accurately.
    absorbedIntoFee = changeRaw;
  }
  const finalFeeSats = args.feeSats + absorbedIntoFee;

  // Hard post-build asserts.
  assertCat21LockTime(tx.lockTime);
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    // Sighash check. Taproot inputs deliberately omit `sighashType`
    // so signers default to SIGHASH_DEFAULT (wire-equivalent to
    // SIGHASH_ALL on key-path spends per BIP-341). Allow undefined
    // for those; require SIGHASH_ALL explicitly on every non-Taproot
    // input.
    const isTaproot = !!input.tapInternalKey;
    if (isTaproot) {
      if (input.sighashType !== undefined && input.sighashType !== btc.SigHash.ALL) {
        throw new Error(`Internal error: input ${i} taproot sighashType=${input.sighashType}, expected undefined or SIGHASH_ALL`);
      }
    } else if (input.sighashType !== btc.SigHash.ALL) {
      throw new Error(`Internal error: input ${i} sighashType is not SIGHASH_ALL`);
    }
    // Sequence check applies to EVERY input, Taproot or not. The
    // per-wallet RBF policy gates the wallet's accelerate UI; scure
    // serialises `sequence` into the wire tx regardless of input
    // type, so a Taproot input with a mis-set sequence would silently
    // ship; this assert runs for every input, not just the non-Taproot
    // branch that carries the sighash check.
    if (input.sequence !== sequence) {
      throw new Error(
        `Internal error: input ${i} sequence=${input.sequence}, expected ${sequence}`
      );
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

