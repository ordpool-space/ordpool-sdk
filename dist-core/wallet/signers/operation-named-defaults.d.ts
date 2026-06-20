import { WalletSigner, WalletSignerInternalImpls } from '../wallet.service.types';
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
export declare function operationNamedDefaults(legacy: WalletSignerInternalImpls): Pick<WalletSigner, 'signSingleFundingInput' | 'signTransfer' | 'signOfferAccept' | 'signOfferCreatePsbt'>;
//# sourceMappingURL=operation-named-defaults.d.ts.map