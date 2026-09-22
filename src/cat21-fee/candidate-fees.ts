/**
 * Per-candidate fee: what each coin in a funding recommendation would actually
 * COST if it were the one spent.
 *
 * A coin picker exists so someone can choose a funding coin, and the fee is
 * part of that choice, because it is not the same for every coin. Sub-dust
 * change is folded into the miner fee by design (`finalFeeSats = feeSats +
 * absorbedIntoFee`), so a coin that leaves clean change pays the simulated fee
 * while a coin whose leftover lands under the dust floor hands the remainder to
 * the miner. Two coins at one fee rate, different money out.
 *
 * `recommendFunding` annotates candidates with content (`bucket`, `assets`) and
 * deliberately knows nothing about transaction shape, so the fee cannot live
 * there. This is the twin that does: the flow supplies how to build and measure
 * itself, and gets back one row per candidate on the same outpoint key the
 * recommendation uses.
 */

import { FundingUtxo } from './coin-selection.helper.js';
import { CatTxFeeSimulation, resolveCatTxFee } from './resolve-cat-tx-fee.helper.js';

/** The outpoint key shared by recommendations, fee rows and consumer lookups. */
export function outpointKey(u: { txid: string; vout: number }): string {
  return `${u.txid}:${u.vout}`;
}

/** What one candidate coin would cost as the funding input. */
export interface CandidateFeeRow {
  txid: string;
  vout: number;
  /**
   * Realised miner fee when this coin funds the transaction, including any
   * absorbed sub-dust change. `null` means the coin cannot fund it at the
   * requested rate — the picker renders that row as unavailable.
   */
  finalFeeSats: number | null;
  /** Measured vsize of that build; `null` alongside an unfundable fee. */
  vsize: number | null;
  /**
   * Of `finalFeeSats`, how many sats were would-be change folded into the miner
   * fee because they fell below the dust floor. `0` means the coin emits change
   * and pays the requested rate. `null` means the coin cannot fund the action,
   * or the flow does not report it.
   *
   * A coin with a positive value here is USABLE and over-paying, which is a
   * different thing from an unavailable coin and the user can act on only one
   * of them. Render it as its own informational signal, not as a block: the
   * fold is deliberate behaviour, not a fault.
   */
  absorbedSubDustSats: number | null;
  /**
   * Why the BUILDER refused this coin, verbatim, or null when it was simply
   * priced. `finalFeeSats: null` alone cannot distinguish "does not cover at
   * this rate" (lower the rate and it appears) from "the builder threw"
   * (no rate will ever help), and a consumer that conflates them prints an
   * instruction the user cannot act on.
   */
  unavailableReason?: string | null;
}

/**
 * What a picker row should SAY about a coin's cost.
 *
 *   - `normal`          the coin emits change and pays the requested rate.
 *   - `overpay`         it can fund the action, but its leftover fell below the
 *                       dust floor and goes to the miner. Usable, and costing
 *                       more than the rate implies. Informational, never a
 *                       block: folding sub-dust change is deliberate.
 *   - `overpay-unknown` it can fund the action and the fold is NOT KNOWN. The
 *                       inscribe flow on an older build reports this, because
 *                       its package price does not expose the commit's own
 *                       fold. Show the fee and claim nothing about over-pay;
 *                       rendering it as `normal` asserts a 0 nobody measured.
 *   - `unavailable`     it cannot fund the action at the requested rate. Name
 *                       the RATE as the variable, so a reader can predict the
 *                       row coming back when they lower it. Never render it as
 *                       free.
 */
export type CandidateFeeState = 'normal' | 'overpay' | 'overpay-unknown' | 'unavailable';

/**
 * The one reading of a fee row, so three surfaces cannot reach three answers
 * from the same two fields. `absorbedSubDustSats` ships as a field rather than
 * a derivation for exactly this reason; the field alone was not enough, because
 * turning it into a state is where the consumers diverged: one collapsed
 * `null` into `normal` and claimed a fold that had not been measured.
 */
export function classifyCandidateFee(row: CandidateFeeRow): CandidateFeeState {
  // Loose null checks on purpose. A consumer whose flow has no `candidateFees`
  // map builds this row by hand from its own simulation, and a field it forgets
  // arrives as `undefined` rather than `null`. Under a strict `=== null` that
  // row falls through to the numeric compare, `undefined > 0` is false, and a
  // coin whose fold nobody measured is reported as paying the plain rate —
  // the exact false claim this function exists to prevent, through a different
  // door. TypeScript cannot catch it, because the row was assembled from
  // another shape.
  if (row.finalFeeSats == null) return 'unavailable';
  if (row.absorbedSubDustSats == null) return 'overpay-unknown';
  return row.absorbedSubDustSats > 0 ? 'overpay' : 'normal';
}

export interface ResolveCandidateFeesArgs<C extends FundingUtxo> {
  /** Build + measure the transaction funded by `candidate` at an absolute fee. */
  simulate: (candidate: C, feeSats: number) => CatTxFeeSimulation;
  /** Sats spendable on fee for this candidate = its value - the fixed outputs. */
  feeBudgetFor: (candidate: C) => number;
  feeRatePerVbyte: number;
}

/**
 * One fee row per candidate, in the order given. Rows are guess-free: every fee
 * comes from `resolveCatTxFee` over real builds, the same two-pass resolution
 * the chosen coin goes through, so the number shown for a coin is the number
 * that coin would actually pay.
 */
export function resolveCandidateFees<C extends FundingUtxo>(
  candidates: readonly C[],
  args: ResolveCandidateFeesArgs<C>,
): CandidateFeeRow[] {
  return candidates.map((candidate) => {
    // A negative budget means the coin cannot cover the fixed outputs;
    // `resolveCatTxFee` returns null for it without invoking the builder.
    //
    // A candidate the BUILDER refuses outright is reported unfundable rather
    // than allowed to throw. This is a row, not the plan: pricing every coin in
    // the pool means one coin the builder cannot handle would otherwise take
    // down the recommendation for every OTHER coin, and a caller that catches
    // around the whole computation then shows a disabled control with nothing
    // to explain it. The CHOSEN coin's build is a separate call and still
    // throws, so a defect on the coin actually being spent still surfaces.
    let resolved: CatTxFeeSimulation | null = null;
    let unavailableReason: string | null = null;
    try {
      resolved = resolveCatTxFee({
        simulate: (feeSats) => args.simulate(candidate, feeSats),
        feeRatePerVbyte: args.feeRatePerVbyte,
        feeBudgetSats: args.feeBudgetFor(candidate),
      });
    } catch (err) {
      // One unbuildable coin is ONE unfundable row, never a failed pool, so the
      // throw does not propagate. But it is NOT swallowed: `resolveCatTxFee`
      // expresses "cannot fund at this rate" as a typed null and throws only
      // for a real fault, so a caught throw and a null mean different things
      // and the row has to carry which. Without the reason a consumer tells the
      // user to lower the fee rate for a coin no rate will ever satisfy.
      unavailableReason = err instanceof Error ? err.message : String(err);
      resolved = null;
    }
    return {
      txid: candidate.txid,
      vout: candidate.vout,
      finalFeeSats: resolved ? resolved.finalFeeSats : null,
      vsize: resolved ? resolved.vsize : null,
      absorbedSubDustSats: resolved ? resolved.absorbedSubDustSats ?? null : null,
      unavailableReason,
    };
  });
}
