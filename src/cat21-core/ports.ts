import { FundingUtxo } from '../cat21-fee/coin-selection.helper.js';

/**
 * The framework-agnostic orchestration core's injected ports. Everything that
 * differs per consumer (where UTXOs come from, how deep the content scan goes,
 * how a PSBT is signed, how a tx is broadcast) is one of these four Promise-
 * based interfaces. The core owns the shared sequencing; the consumer owns the
 * ports. No RxJS — plain `async`.
 */

/**
 * A funding UTXO the account can spend. The core derives the PSBT input shape
 * from the wallet's payment address + pubkey (the input adapter), so the port
 * only carries the outpoint + value here. Cat-bearing / asset coins are
 * excluded by the consumer's `UtxosPort` and the core's content-checked
 * selection — never by a size heuristic.
 */
export interface CoreFundingUtxo extends FundingUtxo {
  /**
   * Previous-tx hex. Required only for a legacy (P2PKH) funding input on a real
   * (non-simulation) build — scure needs `nonWitnessUtxo`. Omit for
   * segwit/taproot funding.
   */
  transactionHex?: string;
}

/**
 * What a scan found on one outpoint, in enough detail to ACT on.
 *
 * A bare verdict is not enough for either audience. A person needs to be told
 * which inscription, which rune, which cat, which rare sat, or they cannot
 * consent to losing it; an agent needs the same facts for the same reason, on
 * an API instead of a screen. Both decisions are the same decision, so both get
 * the same information.
 */
export interface UtxoAssetDetail {
  /** Inscription ids sitting on this outpoint. */
  inscriptionIds: string[];
  /** Rune names present, in ord's spelling (spacers included). */
  runeNames: string[];
  /** CAT-21 cat ids, from a cat21-ord index. */
  catIds: string[];
  /** The rare sat, when one is present. */
  rareSat: { sat: string; block: number; rarity: string } | null;
}

/**
 * Content-safety verdict for one outpoint. The core auto-spends only `clean`.
 *
 * The bare strings remain valid, so a port that only knows yes-or-no keeps
 * working. Returning the object form additionally carries WHAT was found
 * through to the recommendation, which is what lets a caller name the assets
 * rather than say "this coin carries assets".
 */
export type UtxoClassification =
  | 'clean'
  | 'has-assets'
  | { verdict: 'clean' | 'has-assets'; assets?: UtxoAssetDetail };

/** Narrow either form to the verdict alone. */
export function classificationVerdict(c: UtxoClassification): 'clean' | 'has-assets' {
  return typeof c === 'string' ? c : c.verdict;
}

/** The detail a classification carries, when it carries any. */
export function classificationAssets(c: UtxoClassification): UtxoAssetDetail | undefined {
  return typeof c === 'string' ? undefined : c.assets;
}

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

/**
 * Signs a buy-offer's BUYER inputs (1..N) with SIGHASH_ALL WITHOUT finalizing —
 * input 0 (the seller's cat) stays unsigned for the seller to sign at accept
 * time. Returns the partial PSBT bytes: the bid artifact, never broadcast.
 * Distinct from `SignPort.sign`, which finalizes into a broadcast-ready tx.
 */
export interface OfferCreateSignPort {
  signBuyerInputs(psbt: Uint8Array, buyerInputIndexes: number[]): Promise<Uint8Array>;
}
