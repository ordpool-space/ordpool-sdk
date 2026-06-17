/**
 * Coin selection for the CAT-21 flows.
 *
 * cat21.space's UX is "user picks the UTXO" — `Cat21MintOrchestrator`
 * simulates fees against every available UTXO and the user clicks
 * one. cat21-wallet's autonomous flows need the SDK to pick for them.
 *
 * Two strategies, BOTH supported:
 *
 *   - `pickLargestFundingUtxoThatCovers` — **the default**. Matches
 *     the historic SDK policy (see `cat21-mint/utxo-content.types.ts:
 *     findAutoPickCandidate` and `Cat21MintOrchestrator.selectedUtxo`
 *     where the orchestrator auto-sets the largest viable UTXO).
 *     Use this unless you have a specific reason not to.
 *
 *   - `pickSmallestFundingUtxoThatCovers` — opt-in. Only worth using
 *     when the consumer's strategy explicitly wants to preserve the
 *     largest balance for later (e.g. a high-volume autonomous bot
 *     spending many small mints).
 *
 * Both functions are pure. The caller passes the already-loaded UTXO
 * list and asserts the candidate UTXO actually meets safety bucket
 * requirements (cat-bearing UTXOs MUST be excluded — that's the
 * caller's job, see `utxo-content.types.ts:findAutoPickCandidate`).
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
 * **DEFAULT strategy.** Returns the UTXO with the LARGEST value that
 * covers `targetSpendSats`. `null` when no UTXO is large enough.
 *
 * Why largest-first is the SDK default:
 * - **Highest mint-success probability** even at high fee rates — no
 *   "Insufficient funds" surprise at the dust boundary.
 * - **Defragments the wallet** rather than fragmenting it. The
 *   smallest-that-covers strategy leaves change just above dust,
 *   multiplying small UTXOs over time.
 * - **Avoids sub-dust change absorption**. Smallest-covers can leave
 *   change just below the dust limit, where the builders absorb it
 *   into the miner fee — the user effectively over-pays.
 *
 * Source of historic truth: see `cat21-mint/utxo-content.types.ts:109`
 * (`findAutoPickCandidate`) and the JSDoc on
 * `Cat21MintOrchestrator.selectedUtxo` ("auto-set to the largest
 * viable one by default").
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
