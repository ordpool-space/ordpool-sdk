import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { Cat21PreparedInput } from '../cat21-script/prepare-cat21-input';

/**
 * Alias for {@link CAT21_POSTAGE_SATS}, kept for legacy import paths. The
 * canonical constant lives in `cat21-postage.ts`; every cat-touching tx
 * uses the same value across mint, transfer, and offer flows.
 */
export const CAT21_TRANSFER_POSTAGE_SATS = CAT21_POSTAGE_SATS;

/**
 * The cat-bearing UTXO the seller spends to move the cat. The first sat
 * of this UTXO carries the existing cat ordinal; per ordinal-theory
 * FIFO, it travels to the first sat of output 0. Same prepared-input
 * shape as every other cat-touching flow ({@link Cat21PreparedInput}).
 */
export type Cat21TransferCatInput = Cat21PreparedInput;

/**
 * Wallet-provided funding UTXOs that pay the miner fee. Coin selection is
 * the caller's responsibility — the builder does NOT select. The caller
 * may also pass zero funding inputs if the cat UTXO itself has surplus
 * value above postage + fee.
 */
export type Cat21TransferFundingInput = Cat21PreparedInput;

/** Output destinations of a CAT-21 transfer. */
export interface Cat21TransferDestinations {
  /**
   * Where the cat lands. The first sat of this output receives the
   * existing cat AND — because `lockTime=21` is set — a fresh cat is
   * minted onto the same ordinal in the same tx.
   */
  recipientAddress: string;
  /** Where the sender's BTC change goes (when above dust). */
  senderChangeAddress: string;
}
