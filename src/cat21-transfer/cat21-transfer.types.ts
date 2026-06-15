/**
 * Cat-output postage on a CAT-21 transfer transaction. Same value as
 * mint and offer (546 sats) — every flow puts the cat at the first sat
 * of the first output, and the cat-output value is uniform.
 */
export const CAT21_TRANSFER_POSTAGE_SATS = 546;

/**
 * The cat-bearing UTXO the seller spends to move the cat. The first sat
 * of this UTXO carries the existing cat ordinal; per ordinal-theory
 * FIFO, it travels to the first sat of output 0.
 */
export interface Cat21TransferCatInput {
  txid: string;
  vout: number;
  /** Sats locked in the cat-bearing UTXO. Usually 546. */
  value: number;
  /** scriptPubKey of the cat UTXO, raw bytes. */
  scriptPubKey: Uint8Array;
  /** For taproot inputs, the x-only internal public key. */
  tapInternalKey?: Uint8Array;
}

/**
 * Wallet-provided funding UTXOs that pay the miner fee. Coin selection is
 * the caller's responsibility — the builder does NOT select. The caller
 * may also pass zero funding inputs if the cat UTXO itself has surplus
 * value above postage + fee.
 */
export interface Cat21TransferFundingInput {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: Uint8Array;
  tapInternalKey?: Uint8Array;
}

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
