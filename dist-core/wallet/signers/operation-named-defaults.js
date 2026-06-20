"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.operationNamedDefaults = operationNamedDefaults;
/**
 * Default operation-named methods, delegating to a signer's existing
 * legacy generic methods (`signAndBroadcast`, `signMultiInputAndBroadcast`,
 * `signPsbtOnly`) with a HARDCODED signing topology per operation.
 *
 * Once Phase 2 removes the legacy methods, each signer can inline these
 * bodies and drop the indirection. Until then, this helper keeps the
 * 11 signer files near-zero-diff during the interface transition — only
 * the file footer changes (`...operationNamedDefaults(legacy)` spread).
 *
 * The point of these methods is that **the caller doesn't choose
 * indexes**. The orchestrator (and only the orchestrator) supplies
 * `fundingInputCount`, which deterministically maps to indexes
 * `1..count` AT the same address the builder put the funding inputs at.
 * No signingMap, no off-by-one, no per-row sighash drift.
 */
function operationNamedDefaults(legacy) {
    return {
        signSingleFundingInput(input) {
            return legacy.signAndBroadcast({
                psbtBytes: input.psbtBytes,
                paymentAddress: input.paymentAddress,
                network: input.network,
                broadcast: input.broadcast,
                promptForSignedPsbt: input.promptForSignedPsbt,
            });
        },
        signTransfer(input) {
            const paymentIndexes = Array.from({ length: input.fundingInputCount }, (_, i) => i + 1);
            return legacy.signMultiInputAndBroadcast({
                psbtBytes: input.psbtBytes,
                signingMap: [
                    { address: input.ordinalsAddress, indexes: [0] },
                    { address: input.paymentAddress, indexes: paymentIndexes },
                ],
                network: input.network,
                broadcast: input.broadcast,
                promptForSignedPsbt: input.promptForSignedPsbt,
            });
        },
        signOfferAccept(input) {
            return legacy.signMultiInputAndBroadcast({
                psbtBytes: input.psbtBytes,
                signingMap: [{ address: input.ordinalsAddress, indexes: [0] }],
                network: input.network,
                broadcast: input.broadcast,
                promptForSignedPsbt: input.promptForSignedPsbt,
            });
        },
        signOfferCreatePsbt(input) {
            const paymentIndexes = Array.from({ length: input.fundingInputCount }, (_, i) => i + 1);
            return legacy.signPsbtOnly({
                psbtBytes: input.psbtBytes,
                signingMap: [{ address: input.paymentAddress, indexes: paymentIndexes }],
                network: input.network,
                promptForSignedPsbt: input.promptForSignedPsbt,
            });
        },
    };
}
//# sourceMappingURL=operation-named-defaults.js.map