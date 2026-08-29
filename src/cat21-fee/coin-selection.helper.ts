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
 * **OPT-IN strategy (preserve-largest-balance).** Returns the LARGEST-value
 * UTXO that covers `targetSpendSats`; `null` if none does. No longer the
 * default: the flows use best-fit (`pickSmallestFundingUtxoThatCovers`) to
 * stay byte-aligned with ord. Reach for largest-first only with a documented
 * reason — e.g. a high-volume autonomous bot that would rather keep spending
 * one big balance than defragment the wallet against every small operation.
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
 * **DEFAULT strategy (ord-aligned best-fit).** Returns the UTXO with the
 * SMALLEST value that covers `targetSpendSats`; `null` when none is large
 * enough. This is ord's own `select_cardinal_utxo` policy (prefer the
 * smallest covering UTXO), so the transfer / offer flows that use it stay
 * byte-aligned with `ord wallet send` — verified in
 * `e2e/regtest/transfer-ord-parity.spec.ts`. It also minimises change
 * (tighter than largest-first). See `selectOrdParityFunding` in
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
