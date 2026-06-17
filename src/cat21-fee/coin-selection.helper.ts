/**
 * Layer-3 coin selection for the CAT-21 flows.
 *
 * cat21.space's UX is "user picks the UTXO" — `Cat21MintOrchestrator`
 * simulates fees against every available UTXO and the user clicks
 * one. cat21-wallet's autonomous flow needs the SDK to pick for it.
 *
 * `pickSmallestFundingUtxoThatCovers` is the default heuristic:
 * smallest UTXO whose value covers `targetSpendSats`. Minimises
 * "wasted" UTXO size while keeping coin selection simple.
 *
 * Pure function. The caller passes the already-loaded UTXO list.
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
 * Returns the UTXO with the smallest value that still covers
 * `targetSpendSats`. `null` when no UTXO is large enough.
 *
 * Smallest-first is a deliberate choice — picking the largest would
 * "use up" the biggest balance on small spends, fragmenting the
 * wallet over time. Smallest-that-covers preserves spendable balance
 * and keeps change outputs above dust.
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
 * smallest-first. Useful when the caller wants to enumerate options
 * (e.g. cat21.space's per-UTXO fee-simulation grid).
 */
export function listFundingUtxosThatCover<T extends FundingUtxo>(
  args: PickFundingUtxoArgs<T>,
): T[] {
  if (args.targetSpendSats <= 0) {
    throw new Error('targetSpendSats must be positive');
  }
  return [...args.utxos]
    .filter(u => u.value >= args.targetSpendSats)
    .sort((a, b) => a.value - b.value);
}
