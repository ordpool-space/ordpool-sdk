import * as btc from '@scure/btc-signer';
import type { InputData } from 'coin-selection/coin-selection.utils';

import { createMoney } from '@leather.io/utils';

import {
  CoinSelectionRecipient,
  determineUtxosForSpend,
} from '../coin-selection/coin-selection';
import {
  BitcoinNativeSegwitPayer,
  BitcoinTaprootPayer,
  payerToBip32Derivation,
  payerToTapBip32Derivation,
} from '../signer/bitcoin-payer';
import { BtcSignerNetwork } from '../utils/bitcoin.network';
import { BitcoinError } from '../validation/bitcoin-error';

/**
 * CAT-21 mint locktime. The protocol's defining marker: `nLockTime = 21` on
 * the genesis transaction. Anything else is not a cat.
 */
export const CAT21_LOCK_TIME = 21;

/**
 * CAT-21 mint input sequence — `0xfffffffd`.
 *
 * Two bits matter to us:
 *
 *   - `< 0xfffffffe` signals BIP-125 opt-in RBF. The user is allowed to
 *     replace the mint via the wallet's increase-fee flow.
 *   - `< 0xffffffff` keeps the input non-final-for-locktime, so the
 *     transaction-level `nLockTime = 21` is still honored.
 *
 * `0xfffffffd` is the canonical "RBF + locktime honored" value.
 *
 * Why we allow RBF here even though the 2024 Xverse incident killed cats
 * via RBF acceleration: per HARD RULE #1 in CLAUDE.md, the protection is
 * NOT to ban RBF — it is to make sure any replacement we build keeps
 * `nLockTime = 21`. That is enforced in the replacement-construction
 * layer (see `use-btc-increase-fee.ts`), not by refusing to signal RBF
 * on the original mint.
 */
export const CAT21_MINT_INPUT_SEQUENCE = 0xfffffffd;

/**
 * Dust threshold for the cat-bearing output. The genesis sat sits on the
 * first sat of the first output (ordinal theory), so a 546-sat output is
 * fine — anything above standard relay dust holds the cat. We pick 546
 * because it matches what the existing Leather mint flows use and avoids
 * a fee-bumping nightmare if the user wants to consolidate later.
 */
export const CAT21_OUTPUT_VALUE = 546;

export interface GenerateCat21MintTransactionArgs<T> {
  feeRate: number;
  network: BtcSignerNetwork;
  recipient: string;
  utxos: T[];
  changeAddress: string;
  payerLookup(keyOrigin: string): BitcoinNativeSegwitPayer | BitcoinTaprootPayer | undefined;
  /**
   * Optional tipping output. When present and `value > 0`, a third output is
   * added paying `value` sats to `address`. Defaults to no tip per the plan
   * ("just one tipping address. 0 disables the creation of an output").
   */
  tip?: { address: string; value: number };
}

/**
 * Builds an unsigned CAT-21 mint PSBT. The protocol guarantees enforced here:
 *
 * 1. Transaction `nLockTime` is exactly 21. Hard runtime assert.
 * 2. Every input has a sequence < 0xffffffff so the locktime stays honored.
 *    We do NOT forbid RBF signalling here; the protection against losing
 *    nLockTime via RBF lives in the replacement-construction layer (see
 *    `use-btc-increase-fee.ts` and HARD RULE #1 in CLAUDE.md).
 * 3. Output 0 is the recipient receiving 546 sats (the cat sat).
 * 4. Output 1 is change to the payer.
 * 5. Optional output 2 is the tip, when configured.
 *
 * Sub-dust change is absorbed into the miner fee by the coin-selection logic
 * (no output emitted for dust change). This is intentional per the plan:
 * "CAT-21 mint absorbs sub-dust change into the miner fee on purpose (rarer
 * color + faster tx). Don't fix it."
 *
 * Hard runtime asserts at the end of the function defend against accidental
 * future edits that would silently break the locktime guarantee.
 */
export function generateCat21MintUnsignedTransaction<
  T extends InputData & { vout: number; keyOrigin: string },
>({
  feeRate,
  network,
  recipient,
  changeAddress,
  utxos,
  payerLookup,
  tip,
}: GenerateCat21MintTransactionArgs<T>) {
  const recipients: CoinSelectionRecipient[] = [
    { address: recipient, amount: createMoney(CAT21_OUTPUT_VALUE, 'BTC') },
  ];
  if (tip && tip.value > 0) {
    recipients.push({ address: tip.address, amount: createMoney(tip.value, 'BTC') });
  }

  const { inputs, outputs, fee } = determineUtxosForSpend({ feeRate, recipients, utxos });

  if (!inputs.length) throw new BitcoinError('NoInputsToSign');
  if (!outputs.length) throw new BitcoinError('NoOutputsToSign');

  const tx = new btc.Transaction({ lockTime: CAT21_LOCK_TIME });

  for (const input of inputs) {
    const payer = payerLookup(input.keyOrigin);
    if (!payer) {
      // eslint-disable-next-line no-console
      console.log(`No payer found for input with keyOrigin ${input.keyOrigin}`);
      continue;
    }

    const bip32Derivation =
      payer.paymentType === 'p2tr'
        ? { tapBip32Derivation: [payerToTapBip32Derivation(payer)] }
        : { bip32Derivation: [payerToBip32Derivation(payer)] };

    const tapInternalKey =
      payer.paymentType === 'p2tr' ? { tapInternalKey: payer.payment.tapInternalKey } : {};

    tx.addInput({
      txid: input.txid,
      index: input.vout,
      witnessUtxo: {
        script: payer.payment.script,
        amount: BigInt(input.value),
      },
      sequence: CAT21_MINT_INPUT_SEQUENCE,
      ...bip32Derivation,
      ...tapInternalKey,
    });
  }

  outputs.forEach(output => {
    if (!output.address) {
      tx.addOutputAddress(changeAddress, BigInt(output.value), network);
      return;
    }
    tx.addOutputAddress(output.address, BigInt(output.value), network);
  });

  /* Hard asserts: nLockTime=21 is the protocol identity of a cat. The
   * sequence guarantee is weaker — every input must keep locktime honored
   * (sequence < 0xffffffff) but is allowed to signal RBF (sequence <
   * 0xfffffffe). Per CLAUDE.md HARD RULE #1, the protection against
   * RBF-induced cat loss lives in the replacement-construction layer,
   * not by refusing RBF here. */
  if (tx.lockTime !== CAT21_LOCK_TIME) {
    throw new BitcoinError('Cat21MintLockTimeBroken');
  }
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const sequence = input.sequence ?? 0xffffffff;
    if (sequence >= 0xffffffff) {
      throw new BitcoinError('Cat21MintInputSequenceBroken');
    }
  }

  return { tx, hex: tx.hex, psbt: tx.toPSBT(), inputs, fee };
}
