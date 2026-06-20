import { defer, map, switchMap, throwError } from 'rxjs';
import { findSignerOrThrow } from '../wallet/signers';
import { createInscribeTransactions, } from './inscription.service.helper';
export function inscribeAndBroadcast(args) {
    return defer(() => {
        let built;
        try {
            built = createInscribeTransactions({
                paymentOutput: args.paymentOutput,
                paymentPublicKey: args.paymentPublicKey,
                paymentAddress: args.paymentAddress,
                recipientAddress: args.recipientAddress,
                body: args.body,
                contentType: args.contentType,
                envelopeFields: args.envelopeFields,
                feeRatePerVbyte: args.feeRatePerVbyte,
                network: args.network,
            });
        }
        catch (err) {
            return throwError(() => err);
        }
        const signer = findSignerOrThrow(args.walletType);
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
        }).pipe(switchMap(({ txId: commitTxId }) => args.broadcast(built.revealHex).pipe(map((revealTxId) => ({
            commitTxId,
            revealTxId,
            commitAddress: built.commitAddress,
            ephemeral: built.ephemeral,
            fees: built.fees,
        })))));
    });
}
//# sourceMappingURL=inscribe-orchestrator.js.map