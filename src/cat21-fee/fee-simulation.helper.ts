/**
 * Layer-3 two-pass fee simulation. Used by every CAT-21 flow
 * (mint, transfer, offer): vsize depends on the bytes; bytes depend
 * on the fee (because change presence + size depends on what's left
 * after the fee); so we build twice.
 *
 * Pass 1: build + dummy-sign + finalise with a placeholder fee,
 *         read vsize off the resulting transaction.
 * Pass 2: compute `provisionalFee = ceil(vsize × feeRatePerVbyte)`,
 *         re-build with that fee, observe the FINAL vsize (different
 *         if the change crossed the dust limit between passes).
 *
 * Pass-2 vsize is what the final tx ships with; the returned
 * `finalFeeSats` is `ceil(pass2Vsize × feeRatePerVbyte)`.
 *
 * Pure function. No I/O, no Angular. cat21.space's Angular
 * orchestrator and cat21-wallet's React/Webpack background call the
 * same helper — no drift between the two consumer flows.
 *
 * The caller supplies ONE callback `simulate(feeSats)` that does
 * whatever's appropriate for the flow:
 *   - Mint: build via createTransaction(simulation=true), dummy-sign
 *     input 0, finalise, return vsize.
 *   - Transfer: build via buildCat21TransferPsbt, dummy-sign every
 *     input, finalise, return vsize.
 *   - Offer (buyer side): build via buildCat21BuyOfferPsbt, dummy-
 *     sign buyer inputs (seller stays unsigned by contract), finalise
 *     with seller input stub, return vsize.
 *
 * The caller knows the right dummy-sign pattern for its flow; the
 * helper just runs the loop.
 */
export interface TwoPassFeeSimulationArgs<TResult extends { vsize: number }> {
  /**
   * Build the tx with the given fee, dummy-sign whatever needs signing
   * for vsize to be observable, return the full simulation result
   * (must include `vsize`; the caller can attach anything else needed
   * downstream — `tx`, `singleInputAmount`, etc.).
   */
  simulate: (feeSats: number) => TResult;
  /** Target fee rate in sat/vB. */
  feeRatePerVbyte: number;
  /** Placeholder fee used for the vsize-measuring pass. */
  placeholderFeeSats?: number;
}

export interface TwoPassFeeSimulationResult<TResult extends { vsize: number }> {
  /** Final fee in sats, `ceil(pass2Vsize × feeRatePerVbyte)`. */
  finalFeeSats: number;
  /** Virtual size of the FINAL transaction, observed in pass 2. */
  vsize: number;
  /**
   * Pass-2 simulation result. Saves the caller a third
   * `simulate` call when the displayed/returned value is the
   * final-fee simulation itself (cat21.space's per-UTXO grid + the
   * `mint()` flow both want this).
   */
  finalSimulation: TResult;
}

/**
 * Run the two-pass loop and return the final fee + vsize +
 * the pass-2 simulation result. The pass-2 simulation is the one
 * the caller should USE for display or broadcast metadata — it's
 * the simulation that matches the final fee.
 */
export function twoPassFeeSimulation<TResult extends { vsize: number }>(
  args: TwoPassFeeSimulationArgs<TResult>,
): TwoPassFeeSimulationResult<TResult> {
  if (args.feeRatePerVbyte <= 0) {
    throw new Error('feeRatePerVbyte must be positive');
  }

  const placeholderFee = args.placeholderFeeSats ?? 1_000;

  // Pass 1 — placeholder fee → vsize.
  const pass1 = args.simulate(placeholderFee);
  const provisionalFee = Math.ceil(pass1.vsize * args.feeRatePerVbyte);

  // Pass 2 — provisional fee → FINAL vsize (different if change
  // crossed dust). The returned fee is rate × pass2Vsize.
  const pass2 = args.simulate(provisionalFee);
  const finalFeeSats = Math.ceil(pass2.vsize * args.feeRatePerVbyte);

  return {
    finalFeeSats,
    vsize: pass2.vsize,
    finalSimulation: pass2,
  };
}
