import * as btc from '@scure/btc-signer';

import { CAT21_POSTAGE_SATS } from '../cat21-postage';
import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { resolveCat21InputSequence } from './cat21-mint-sequence';

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
 * Funding UTXO the wallet selects to pay postage + miner fee + optional
 * tip. Coin selection is the caller's responsibility — the builder
 * does NOT select.
 */
export interface Cat21MintFundingInput {
  txid: string;
  vout: number;
  value: number;
  /** scriptPubKey bytes. */
  scriptPubKey: Uint8Array;
  /** For taproot inputs, the x-only internal public key. */
  tapInternalKey?: Uint8Array;
}

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
}

export interface BuildCat21MintResult {
  /** Raw hex of the unsigned tx. */
  hex: string;
  /** Raw PSBT bytes. */
  psbt: Uint8Array;
  /** Change output value (0 when sub-dust; absorbed into fee). */
  changeSats: number;
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
  const sequence = resolveCat21InputSequence(args.walletType);

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

  // Change calculation.
  const required = postageSats + tipValueSats + args.feeSats;
  const changeRaw = args.fundingInput.value - required;
  if (changeRaw < 0) {
    throw new Error(
      `Mint funding insufficient: ${args.fundingInput.value} sats < ${required} sats required`
    );
  }
  let changeSats = 0;
  if (changeRaw >= CAT21_MINT_CHANGE_DUST_LIMIT_SATS) {
    changeSats = changeRaw;
    tx.addOutputAddress(args.destinations.senderChangeAddress, BigInt(changeSats), scureNetwork);
  }

  // Hard post-build asserts.
  if (tx.lockTime !== 21) {
    throw new Error(`Internal error: lockTime=${tx.lockTime}, expected 21`);
  }
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    if (input.sighashType !== btc.SigHash.ALL) {
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
    changeSats,
  };
}

function addInput(
  tx: btc.Transaction,
  utxo: Cat21MintFundingInput,
  sequence: number
): void {
  const inputBase: btc.TransactionInputUpdate = {
    txid: utxo.txid,
    index: utxo.vout,
    sequence,
    sighashType: btc.SigHash.ALL,
    witnessUtxo: {
      script: utxo.scriptPubKey,
      amount: BigInt(utxo.value),
    },
  };
  if (utxo.tapInternalKey) {
    tx.addInput({ ...inputBase, tapInternalKey: utxo.tapInternalKey });
  } else {
    tx.addInput(inputBase);
  }
}
