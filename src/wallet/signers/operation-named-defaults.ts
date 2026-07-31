import { Observable } from 'rxjs';

import {
  SignOfferAcceptArgs,
  SignOfferCreatePsbtArgs,
  SignSingleFundingInputArgs,
  SignTransferArgs,
  WalletSigner,
  WalletSignerInternalImpls,
} from '../wallet.service.types';

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
export function operationNamedDefaults(
  legacy: WalletSignerInternalImpls,
): Pick<WalletSigner,
  | 'signSingleFundingInput'
  | 'signTransfer'
  | 'signOfferAccept'
  | 'signOfferCreatePsbt'
> {
  return {
    signSingleFundingInput(input: SignSingleFundingInputArgs): Observable<{ txId: string }> {
      return legacy.signAndBroadcast({
        psbtBytes: input.psbtBytes,
        paymentAddress: input.paymentAddress,
        paymentPublicKey: input.paymentPublicKey,
        network: input.network,
        broadcast: input.broadcast,
        promptForSignedPsbt: input.promptForSignedPsbt,
      });
    },

    signTransfer(input: SignTransferArgs): Observable<{ txId: string }> {
      const paymentIndexes = Array.from(
        { length: input.fundingInputCount },
        (_, i) => i + 1,
      );
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

    signOfferAccept(input: SignOfferAcceptArgs): Observable<{ txId: string }> {
      return legacy.signMultiInputAndBroadcast({
        psbtBytes: input.psbtBytes,
        signingMap: [{ address: input.ordinalsAddress, indexes: [0] }],
        network: input.network,
        broadcast: input.broadcast,
        promptForSignedPsbt: input.promptForSignedPsbt,
      });
    },

    signOfferCreatePsbt(input: SignOfferCreatePsbtArgs): Observable<Uint8Array> {
      const paymentIndexes = Array.from(
        { length: input.fundingInputCount },
        (_, i) => i + 1,
      );
      return legacy.signPsbtOnly({
        psbtBytes: input.psbtBytes,
        signingMap: [{ address: input.paymentAddress, indexes: paymentIndexes }],
        network: input.network,
        promptForSignedPsbt: input.promptForSignedPsbt,
      });
    },
  };
}
