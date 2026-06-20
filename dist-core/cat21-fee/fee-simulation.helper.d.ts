/**
 * Layer-3 two-pass fee simulation for mint / transfer / offer.
 * vsize depends on the bytes, bytes depend on the fee (change
 * presence + size depends on what's left), so we build twice:
 *
 *   Pass 1 — placeholder fee → measure vsize.
 *   Pass 2 — `ceil(vsize × feeRate)` → measure FINAL vsize (may
 *            differ if change crossed the dust limit between passes).
 *
 * `finalFeeSats = ceil(pass2Vsize × feeRate)`. Pure function.
 *
 * The caller's `simulate(feeSats)` callback does the per-flow
 * dummy-sign:
 *   - Mint: build via createTransaction(simulation=true), dummy-sign
 *     input 0, finalise, return vsize.
 *   - Transfer: build + dummy-sign every input + finalise.
 *   - Offer (buyer): build + dummy-sign buyer inputs (seller stays
 *     unsigned by contract) + finalise with seller input stub.
 */
export interface TwoPassFeeSimulationArgs<TResult extends {
    vsize: number;
}> {
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
export interface TwoPassFeeSimulationResult<TResult extends {
    vsize: number;
}> {
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
export declare function twoPassFeeSimulation<TResult extends {
    vsize: number;
}>(args: TwoPassFeeSimulationArgs<TResult>): TwoPassFeeSimulationResult<TResult>;
//# sourceMappingURL=fee-simulation.helper.d.ts.map