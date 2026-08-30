/**
 * Guess-free fee resolution for a cat-touching tx (mint / transfer / offer).
 *
 * The miner fee is `vsize x feeRate`, but the vsize depends on the fee: a
 * change output is present only while the leftover clears the dust floor, and a
 * cat tx has exactly two possible sizes — WITH a change output, or WITHOUT
 * (leftover absorbed into the fee). Rather than seed the sizing pass with an
 * eyeballed vB ceiling (the old `* 200` / `* 220`), this measures both forms
 * from real builds:
 *
 *   1. Build at fee 0 -> the WITH-CHANGE form (leftover is maximal, so a change
 *      output is present); its vsize gives the with-change fee.
 *   2. If that fee fits the budget, settle at it (a shrink to the no-change form
 *      between the two passes is absorbed by the builder and reflected in the
 *      returned `finalFeeSats`).
 *   3. Otherwise spend the WHOLE budget as fee (no change output; always a valid
 *      build for a covered coin) and accept iff that still clears the requested
 *      rate for the no-change size. This is the case the old fixed-ceiling path
 *      wrongly rejected: a coin that fits a no-change tx but not the inflated
 *      ceiling.
 *
 * `feeBudgetSats` is the sats spendable on fee = inputs total - the fixed
 * outputs (cat postage + tip, plus price + preserved value for offers). The
 * `simulate` callback MUST accept any fee in `[0, feeBudgetSats]` without
 * throwing (the builder only rejects a fee exceeding the budget). Returns the
 * pass-2 simulation (whose `finalFeeSats` is the realised fee, sub-dust absorb
 * included), or `null` when even the whole budget can't meet the rate.
 */
export interface CatTxFeeSimulation {
  vsize: number;
  /** Realised miner fee for this build = requested fee + any absorbed sub-dust change. */
  finalFeeSats: number;
}

export interface ResolveCatTxFeeArgs<T extends CatTxFeeSimulation> {
  /** Build + measure the tx at an absolute miner fee within `[0, feeBudgetSats]`. */
  simulate: (feeSats: number) => T;
  feeRatePerVbyte: number;
  /** Max sats spendable on fee = inputs total - fixed outputs. */
  feeBudgetSats: number;
}

export function resolveCatTxFee<T extends CatTxFeeSimulation>(
  args: ResolveCatTxFeeArgs<T>,
): T | null {
  const { simulate, feeRatePerVbyte: rate, feeBudgetSats: budget } = args;
  if (!(rate > 0)) throw new Error('feeRatePerVbyte must be positive');
  if (budget < 0) return null;

  // With-change form: fee 0 keeps the leftover maximal, so a change output is
  // present and we measure the larger of the two possible sizes.
  const withChange = simulate(0);
  const withChangeFee = Math.ceil(withChange.vsize * rate);
  if (withChangeFee <= budget) {
    // Affordable. Settle at that fee; if the leftover now falls below dust the
    // builder drops the change output and folds it into `finalFeeSats`.
    const settled = simulate(withChangeFee);
    if (Math.ceil(settled.vsize * rate) <= budget) return settled;
  }

  // With-change doesn't fit the budget. Spend the whole budget as fee (no change
  // output; always a valid build for a covered coin) and accept iff that clears
  // the requested rate for the no-change size.
  const noChange = simulate(budget);
  if (budget >= Math.ceil(noChange.vsize * rate)) return noChange;
  return null;
}
