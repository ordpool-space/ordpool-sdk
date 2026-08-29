import { FundingUtxo } from '../cat21-fee/coin-selection.helper';

/**
 * The framework-agnostic orchestration core's injected ports. Everything that
 * differs per consumer (where UTXOs come from, how deep the content scan goes,
 * how a PSBT is signed, how a tx is broadcast) is one of these four Promise-
 * based interfaces. The core owns the shared sequencing; the consumer owns the
 * ports. No Angular, no RxJS — plain `async`.
 */

/**
 * A funding UTXO ready for a cat21 builder. Cat-bearing / asset coins are
 * excluded by the consumer's `UtxosPort` and the core's content-checked
 * selection — never by a size heuristic.
 */
export interface CoreFundingUtxo extends FundingUtxo {
  /** scriptPubKey bytes; the builder derives the input shape from it. */
  scriptPubKey: Uint8Array;
  /** Taproot internal key, when the UTXO sits on a P2TR output. */
  tapInternalKey?: Uint8Array;
}

/** Content-safety verdict for one outpoint. The core auto-spends only `clean`. */
export type UtxoClassification = 'clean' | 'has-assets';

/** Where the account's spendable funding UTXOs come from. */
export interface UtxosPort {
  spendableUtxos(address: string): Promise<CoreFundingUtxo[]>;
}

/**
 * Classifies one outpoint's on-chain content. Scan DEPTH is the consumer's
 * choice — cat-only (cat21-wallet today) or full (cat21.space: cats +
 * inscriptions + runes + rare sats). The core avoids whatever the port flags as
 * `has-assets`. Reject to signal a scan failure; the core treats a failed scan
 * as not-auto (expert-mode), never as clean.
 */
export interface ContentScanPort {
  classify(outpoint: string): Promise<UtxoClassification>;
}

export interface SignedTxBytes {
  hex: string;
  weight: number;
}

/**
 * Signs a PSBT. `inputIndexes` constrains which inputs are signed: `'all'` for
 * wallet-built mint/transfer txs (every input is ours), a list for offer flows
 * (e.g. `[0]` for the seller's cat input on accept).
 */
export interface SignPort {
  sign(psbt: Uint8Array, inputIndexes: 'all' | number[]): Promise<SignedTxBytes>;
}

export interface BroadcastOutcome {
  txid: string;
  channel: 'mempool' | 'slipstream';
}

/** Broadcasts a signed tx (mempool, or Slipstream for oversize). */
export interface BroadcastPort {
  broadcast(signedTxHex: string): Promise<BroadcastOutcome>;
}
