import * as btc from '@scure/btc-signer';

import { CAT21_LOCK_TIME, assertCat21LockTime } from '../cat21-protocol/cat21-lock-time';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { Network, toScureNetwork } from '../network';
import { CAT21_WALLET_INPUT_SEQUENCE } from '../cat21-protocol/cat21-sequence';
import { getMinimumUtxoSize } from '../cat21-script/address-format';
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
   * Which wallet will sign this PSBT. Determines the input sequence:
   *   - `cat21wallet`: sequence = 0xfffffffd (RBF on; our accelerate
   *     flow preserves `lockTime=21` through replacement).
   *   - any other wallet: sequence = 0xfffffffe (RBF off; third-party
   *     accelerate UIs can't fire on this tx and accidentally drop
   *     the marker on replacement).
   */
  walletType: KnownOrdinalWalletType;
  network: Network;
  catUtxo: Cat21TransferCatInput;
  /**
   * Funding UTXOs that cover postage + fee above what the cat UTXO
   * already provides. May be empty when the cat UTXO is large enough
   * to self-fund.
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
  /** Total funding input value (sum of fundingInputs.value). 0 when self-funded. */
  fundingInputTotalSats: number;
  /** Change output value (0 when sub-dust; absorbed into fee). */
  changeSats: number;
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
 *   Input 0  — cat-bearing UTXO. Cat's sat is the first sat of this
 *              UTXO; ends up at the first sat of output 0 (FIFO).
 *   Input 1+ — funding UTXOs (empty when the cat UTXO has surplus).
 *   Output 0 — recipient address, postage sats. Cat lands here.
 *   Output 1 — change (absorbed into fee when sub-dust).
 *
 * Hard invariants (asserted): lockTime=21, per-wallet sequence,
 * every input SIGHASH_ALL. Coin selection is the caller's job.
 */
export function buildCat21TransferPsbt(args: BuildCat21TransferArgs): BuildCat21TransferResult {
  const postageSats = CAT21_POSTAGE_SATS;
  // HARD RULE: cat UTXO is always exactly 546 sats. See SDK CLAUDE.md.
  if (args.catUtxo.value !== CAT21_POSTAGE_SATS) {
    throw new Error(
      `catUtxo.value must equal CAT21_POSTAGE_SATS (${CAT21_POSTAGE_SATS}); got ${args.catUtxo.value}`
    );
  }
  if (args.feeSats < 0) throw new Error('feeSats must be non-negative');

  const scureNetwork = toScureNetwork(args.network);
  // RBF-on for every wallet on transfers. The mint-only RBF-off policy
  // (`resolveCat21MintInputSequence`) does NOT apply here: the cat is
  // already on chain, so a third-party wallet's accelerate UI dropping
  // `lockTime=21` on an RBF replacement only loses the bonus mint, not
  // the cat itself. Third-party wallets stuck at old fees CAN bump. Was
  // wrong pre-2026-07-25; see cat21-sequence.ts docstring.
  const sequence = CAT21_WALLET_INPUT_SEQUENCE;

  const tx = new btc.Transaction({
    lockTime: CAT21_LOCK_TIME,
    allowLegacyWitnessUtxo: true,
    disableScriptCheck: true,
  });

  // Input 0: the cat-bearing UTXO.
  addInput(tx, args.catUtxo, sequence);

  // Input 1..N: funding UTXOs (may be empty).
  let fundingInputTotalSats = 0;
  for (const funding of args.fundingInputs) {
    fundingInputTotalSats += funding.value;
    addInput(tx, funding, sequence);
  }

  // Output 0: recipient. Cat ordinal travels here via FIFO; `lockTime=21`
  // mints a fresh cat onto the same sat in the same tx.
  tx.addOutputAddress(args.destinations.recipientAddress, BigInt(postageSats), scureNetwork);

  // Change math. Total in = cat UTXO value + funding inputs.
  // Required out = postage + fee. Anything left over is change.
  const totalInSats = args.catUtxo.value + fundingInputTotalSats;
  const changeRaw = totalInSats - postageSats - args.feeSats;
  if (changeRaw < 0) {
    throw new Error(
      `Transfer funding insufficient: ${totalInSats} sats < ${postageSats + args.feeSats} sats required`
    );
  }
  // Per-address-type dust floor for the change output. The
  // CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS constant (546) is the
  // conservative cross-type floor and stays in place as a defence-
  // in-depth fallback if getMinimumUtxoSize ever fails to classify
  // the address; the per-address value is preferred so P2TR (330)
  // and P2WPKH (294) change amounts in [dust, 546) actually get
  // emitted instead of being silently absorbed into the miner fee.
  // Was hardcoded 546 pre-2026-07-26 (finding #13).
  let changeDustLimit: number;
  try {
    changeDustLimit = getMinimumUtxoSize(args.destinations.senderChangeAddress);
  } catch {
    changeDustLimit = CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS;
  }
  let changeSats = 0;
  if (changeRaw >= changeDustLimit) {
    changeSats = changeRaw;
    tx.addOutputAddress(args.destinations.senderChangeAddress, BigInt(changeSats), scureNetwork);
  }

  // Hard post-build asserts. SIGHASH_ALL commits to lockTime + sequence
  // across the whole tx, so once any input signs, the 21 marker AND
  // the chosen RBF semantics are cryptographically locked.
  assertCat21LockTime(tx.lockTime);
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    // Taproot inputs intentionally omit sighashType (see addInput);
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
  };
}

function addInput(
  tx: btc.Transaction,
  utxo: Cat21TransferCatInput | Cat21TransferFundingInput,
  sequence: number
): void {
  // Legacy P2PKH path: scure refuses to sign legacy inputs from
  // witnessUtxo alone, the caller must supply the full prev-tx bytes
  // via nonWitnessUtxo.
  if (utxo.nonWitnessUtxo) {
    const legacyInput: btc.TransactionInputUpdate = {
      txid: utxo.txid,
      index: utxo.vout,
      sequence,
      sighashType: btc.SigHash.ALL,
      nonWitnessUtxo: utxo.nonWitnessUtxo,
    };
    if (utxo.redeemScript) legacyInput.redeemScript = utxo.redeemScript;
    tx.addInput(legacyInput);
    return;
  }

  // SegWit family: witnessUtxo + optional redeemScript (P2SH-wrap) +
  // optional tapInternalKey (Taproot key-path).
  //
  // Taproot inputs OMIT sighashType — see the same comment in
  // cat21-mint.helper.ts. SIGHASH_DEFAULT and SIGHASH_ALL commit to
  // identical bytes for Taproot key-path spends (BIP-341); omitting
  // the field lets the wallet's signer use its default (DEFAULT) and
  // avoids the Alby/bitcoinjs-lib whitelist rejection.
  const isTaproot = !!utxo.tapInternalKey;
  const inputBase: btc.TransactionInputUpdate = {
    txid: utxo.txid,
    index: utxo.vout,
    sequence,
    witnessUtxo: {
      script: utxo.scriptPubKey,
      amount: BigInt(utxo.value),
    },
  };
  if (!isTaproot) inputBase.sighashType = btc.SigHash.ALL;
  if (utxo.redeemScript) inputBase.redeemScript = utxo.redeemScript;
  if (utxo.tapInternalKey) inputBase.tapInternalKey = utxo.tapInternalKey;
  tx.addInput(inputBase);
}
