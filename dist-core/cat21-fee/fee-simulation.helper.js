"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.twoPassFeeSimulation = twoPassFeeSimulation;
/**
 * Run the two-pass loop and return the final fee + vsize +
 * the pass-2 simulation result. The pass-2 simulation is the one
 * the caller should USE for display or broadcast metadata — it's
 * the simulation that matches the final fee.
 */
function twoPassFeeSimulation(args) {
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
//# sourceMappingURL=fee-simulation.helper.js.map