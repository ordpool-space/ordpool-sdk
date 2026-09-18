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
    const resolved = resolveCatTxFee({
      simulate: (feeSats) => args.simulate(candidate, feeSats),
      feeRatePerVbyte: args.feeRatePerVbyte,
      feeBudgetSats: args.feeBudgetFor(candidate),
    });
    return {
      txid: candidate.txid,
      vout: candidate.vout,
      finalFeeSats: resolved ? resolved.finalFeeSats : null,
      vsize: resolved ? resolved.vsize : null,
    };
  });
}
