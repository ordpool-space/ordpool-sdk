"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inscribeAndBroadcast = inscribeAndBroadcast;
const rxjs_1 = require("rxjs");
const signers_1 = require("../wallet/signers");
const inscription_service_helper_1 = require("./inscription.service.helper");
function inscribeAndBroadcast(args) {
    return (0, rxjs_1.defer)(() => {
        let built;
        try {
            built = (0, inscription_service_helper_1.createInscribeTransactions)({
                paymentOutput: args.paymentOutput,
                paymentPublicKey: args.paymentPublicKey,
                paymentAddress: args.paymentAddress,
                recipientAddress: args.recipientAddress,
                body: args.body,
                contentType: args.contentType,
                envelopeFields: args.envelopeFields,
                feeRatePerVbyte: args.feeRatePerVbyte,
                tip: args.tip,
                network: args.network,
            });
        }
        catch (err) {
            return (0, rxjs_1.throwError)(() => err);
        }
        const signer = (0, signers_1.findSignerOrThrow)(args.walletType);
        // The signer's broadcast callback is invoked with the signed
        // commit wire-tx hex. We intercept to (a) fire the consumer's
        // onCommitSigned hook, (b) actually broadcast via the consumer's
        // broadcast callback.
        const captureAndBroadcast = (signedCommitHex) => {
            if (args.onCommitSigned) {
                try {
                    args.onCommitSigned(signedCommitHex);
                }
                catch { /* swallow */ }
            }
            return args.broadcast(signedCommitHex);
        };
        return signer.signSingleFundingInput({
            psbtBytes: built.commitPsbt,
            paymentAddress: args.paymentAddress,
            network: args.network,
            broadcast: captureAndBroadcast,
            promptForSignedPsbt: args.promptForSignedPsbt,
        }).pipe((0, rxjs_1.switchMap)(({ txId: commitTxId }) => args.broadcast(built.revealHex).pipe((0, rxjs_1.map)((revealTxId) => ({
            commitTxId,
            revealTxId,
            commitAddress: built.commitAddress,
            ephemeral: built.ephemeral,
            fees: built.fees,
        })))));
    });
}
//# sourceMappingURL=inscribe-orchestrator.js.map