/**
 * Coin selection for CAT-21 flows. cat21.space lets the user pick
 * (Cat21MintOrchestrator simulates against every UTXO); cat21-wallet's
 * autonomous flows pick via the SDK.
 *
 * Two strategies:
 *   - `pickLargestFundingUtxoThatCovers` — **default**, matches the
 *     historic policy (see `findAutoPickCandidate`).
 *   - `pickSmallestFundingUtxoThatCovers` — opt-in, for strategies
 *     that want to preserve the largest balance (high-volume bot
 *     spending many small mints).
 *
 * Both pure. Caller MUST exclude cat-bearing UTXOs from the input
 * list — that filter is not this helper's job.
 */

export interface FundingUtxo {
  txid: string;
  vout: number;
  /** Value in sats. */
  value: number;
}

export interface PickFundingUtxoArgs<T extends FundingUtxo> {
  utxos: ReadonlyArray<T>;
  /** Minimum value the picked UTXO must cover. */
  targetSpendSats: number;
}

/**
 * **DEFAULT strategy.** Returns the LARGEST-value UTXO that covers
 * `targetSpendSats`; `null` if none does. Picked as default because
 * largest-first:
 *
 *   - has highest mint-success probability at high fee rates (no
 *     "Insufficient funds" surprise at the dust boundary);
 *   - defragments the wallet instead of fragmenting it;
 *   - avoids sub-dust change absorption (smallest-covers can leave
 *     change just under dust, where the builders fold it into the
 *     miner fee — the user over-pays).
 */
export function pickLargestFundingUtxoThatCovers<T extends FundingUtxo>(
  args: PickFundingUtxoArgs<T>,
): T | null {
  if (args.utxos.length === 0) return null;
  if (args.targetSpendSats <= 0) {
    throw new Error('targetSpendSats must be positive');
  }
  const sorted = [...args.utxos]
    .filter(u => u.value >= args.targetSpendSats)
    .sort((a, b) => b.value - a.value);
  return sorted[0] ?? null;
}

/**
 * OPT-IN strategy. Returns the UTXO with the SMALLEST value that
 * covers `targetSpendSats`. `null` when no UTXO is large enough.
 *
 * Use ONLY when the consumer explicitly wants to preserve their
 * largest balance for later — e.g. a high-volume autonomous bot
 * spending many small mints in sequence where defragmenting the
 * wallet against each mint would slowly consume the big balance.
 *
 * For most flows (cat21.space user flow, one-shot mints, transfers,
 * offer creation) `pickLargestFundingUtxoThatCovers` is the right
 * call. Default to that unless you have a documented reason.
 */
export function pickSmallestFundingUtxoThatCovers<T extends FundingUtxo>(
  args: PickFundingUtxoArgs<T>,
): T | null {
  if (args.utxos.length === 0) return null;
  if (args.targetSpendSats <= 0) {
    throw new Error('targetSpendSats must be positive');
  }
  const sorted = [...args.utxos]
    .filter(u => u.value >= args.targetSpendSats)
    .sort((a, b) => a.value - b.value);
  return sorted[0] ?? null;
}

/**
 * Returns ALL UTXOs that can cover `targetSpendSats`, sorted
 * largest-first (matches the default pick strategy). Useful when the
 * caller wants to enumerate options (e.g. cat21.space's per-UTXO
 * fee-simulation grid where the user picks from the list).
 */
export function listFundingUtxosThatCover<T extends FundingUtxo>(
  args: PickFundingUtxoArgs<T>,
): T[] {
  if (args.targetSpendSats <= 0) {
    throw new Error('targetSpendSats must be positive');
  }
  return [...args.utxos]
    .filter(u => u.value >= args.targetSpendSats)
    .sort((a, b) => b.value - a.value);
}
