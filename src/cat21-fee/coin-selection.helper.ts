/**
 * Value-based coin-selection helpers for CAT-21 flows. Both are OPT-IN
 * strategies for a caller that wants a simple "pick one covering UTXO by
 * value" WITHOUT the content-safety layer — e.g. a high-volume autonomous
 * bot that has already vetted its own UTXO set.
 *
 * The action orchestrators (mint / transfer / offer / inscribe) do NOT call
 * these directly. They select through `FundingRecommendationService` +
 * `recommendFunding`, which force-scans the covering coins for content and
 * auto-picks the best-fit CONTENT-CLEAN coin via ord's `selectCardinalUtxo`
 * (falling back to expert-mode when only asset-bearing coins cover). Reach for
 * the helpers below only when you deliberately want value-only selection.
 *
 * Two strategies:
 *   - `pickSmallestFundingUtxoThatCovers` — best-fit (smallest covering);
 *     minimises change, matches ord's `select_cardinal_utxo` value policy.
 *   - `pickLargestFundingUtxoThatCovers` — preserve-largest-balance
 *     (largest covering).
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
 * **OPT-IN strategy (preserve-largest-balance).** Returns the LARGEST-value
 * UTXO that covers `targetSpendSats`; `null` if none does. Reach for
 * largest-first only with a documented reason — e.g. a high-volume autonomous
 * bot that would rather keep spending one big balance than defragment the
 * wallet against every small operation. The action orchestrators select via
 * the content-safe recommendation instead (see the module doc).
 */
/**
 * Shared filter+sort: every UTXO whose value covers `targetSpendSats`,
 * ordered by value (`'desc'` = largest-first, `'asc'` = smallest-first).
 * Throws on a non-positive target. The three public entry points below
 * document their strategy and layer their own empty-list handling on
 * top; this owns the covering-filter + sort in one place.
 */
function sortedCovering<T extends FundingUtxo>(
  utxos: ReadonlyArray<T>,
  targetSpendSats: number,
  dir: 'desc' | 'asc',
): T[] {
  if (targetSpendSats <= 0) {
    throw new Error('targetSpendSats must be positive');
  }
  const sign = dir === 'desc' ? -1 : 1;
  return [...utxos]
    .filter(u => u.value >= targetSpendSats)
    .sort((a, b) => sign * (a.value - b.value));
}

export function pickLargestFundingUtxoThatCovers<T extends FundingUtxo>(
  args: PickFundingUtxoArgs<T>,
): T | null {
  if (args.utxos.length === 0) return null;
  return sortedCovering(args.utxos, args.targetSpendSats, 'desc')[0] ?? null;
}

/**
 * **OPT-IN best-fit strategy.** Returns the UTXO with the SMALLEST value that
 * covers `targetSpendSats`; `null` when none is large enough. This is ord's
 * own `select_cardinal_utxo` policy (prefer the smallest covering UTXO), so a
 * caller using it directly stays byte-aligned with `ord wallet send` (verified
 * in `e2e/regtest/transfer-ord-parity.spec.ts`); it also minimises change
 * (tighter than largest-first). The action orchestrators reach this policy
 * indirectly through `recommendFunding`, which applies `selectCardinalUtxo` to
 * the content-CLEAN candidates only. See `selectOrdParityFunding` in
 * `ord-coin-select.ts` for the full multi-input ord port.
 */
export function pickSmallestFundingUtxoThatCovers<T extends FundingUtxo>(
  args: PickFundingUtxoArgs<T>,
): T | null {
  if (args.utxos.length === 0) return null;
  return sortedCovering(args.utxos, args.targetSpendSats, 'asc')[0] ?? null;
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
  return sortedCovering(args.utxos, args.targetSpendSats, 'desc');
}
