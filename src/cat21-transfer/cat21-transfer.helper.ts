import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network';
import { resolveCat21InputSequence } from '../cat21-mint/cat21-mint-sequence';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  CAT21_TRANSFER_POSTAGE_SATS,
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
  /** Optional override for the cat-output postage. Defaults to 546. */
  postageSats?: number;
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
 * Every cat-touching tx OUR code builds is structurally a CAT-21 mint:
 * we set `lockTime=21` so cat21-ord mints a fresh cat onto the same
 * ordinal that already carries the original cat. Per cat21/README.md,
 * a single CAT-21 ordinal can carry multiple cats through repeated
 * minting. The value `21` is pure protocol-marker data — block 21 was
 * mined in 2009, so the field has no consensus meaning.
 *
 * Structure:
 *   Input 0  — cat-bearing UTXO. The cat's sat is the first sat of this
 *              UTXO and (by ordinal-theory FIFO) ends up at the first
 *              sat of output 0.
 *   Input 1+ — funding UTXOs (may be empty when the cat UTXO has
 *              surplus value).
 *   Output 0 — recipient address, postage sats. Cat + fresh mint land
 *              here.
 *   Output 1 — change to senderChangeAddress (skipped when sub-dust;
 *              absorbed into the miner fee).
 *
 * Hard invariants (asserted before return):
 *   1. `lockTime === 21`.
 *   2. Every input's sequence matches the per-wallet rule.
 *   3. Every input carries SIGHASH_ALL.
 *
 * Coin selection (which cat UTXO + which funding UTXOs) is the
 * caller's responsibility.
 */
export function buildCat21TransferPsbt(args: BuildCat21TransferArgs): BuildCat21TransferResult {
  const postageSats = args.postageSats ?? CAT21_TRANSFER_POSTAGE_SATS;
  if (postageSats < 330) throw new Error('postageSats below safe dust threshold');
  if (args.catUtxo.value < 1) throw new Error('catUtxo.value must be positive');
  if (args.feeSats < 0) throw new Error('feeSats must be non-negative');

  const scureNetwork = toScureNetwork(args.network);
  const sequence = resolveCat21InputSequence(args.walletType);

  const tx = new btc.Transaction({
    lockTime: 21,
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
  let changeSats = 0;
  if (changeRaw >= CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS) {
    changeSats = changeRaw;
    tx.addOutputAddress(args.destinations.senderChangeAddress, BigInt(changeSats), scureNetwork);
  }

  // Hard post-build asserts. SIGHASH_ALL commits to lockTime + sequence
  // across the whole tx, so once any input signs, the 21 marker AND
  // the chosen RBF semantics are cryptographically locked.
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
    fundingInputTotalSats,
    changeSats,
  };
}

function addInput(
  tx: btc.Transaction,
  utxo: Cat21TransferCatInput | Cat21TransferFundingInput,
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
