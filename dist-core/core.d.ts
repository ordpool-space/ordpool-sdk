/**
 * `ordpool-sdk/core` — the SDK's pure-functional entry point.
 *
 * Re-exports only the helpers, constants and types that have ZERO
 * runtime dependency on Angular. Consumers without an Angular runtime
 * (the cat21-wallet Chrome extension, CLIs, GitHub Actions, any plain
 * Node service) import from here:
 *
 *     import { buildCat21TransferPsbt } from 'ordpool-sdk/core';
 *
 * The main entry point (`ordpool-sdk`) still re-exports everything in
 * this file PLUS the Angular-aware services (`WalletService`,
 * `Cat21Service`, `Cat21MintOrchestrator`, etc.) for cat21.space and
 * any other Angular consumer.
 *
 * Convention: when adding a new pure helper to the SDK, export it from
 * its own file as usual AND add a re-export here. Adding an Angular
 * dependency to a file already re-exported from this entry point is a
 * structural regression — the architecture spec in the cat21-wallet
 * repo (apps/extension/src/__architecture__/architecture.spec.ts)
 * pins that all wallet imports of SDK symbols go through `'ordpool-
 * sdk/core'`, never through bare `'ordpool-sdk'`.
 */
export * from './cat21-protocol';
export * from './cat21-script';
export * from './network';
export { KnownOrdinalWalletType, KnownOrdinalWallets, type KnownOrdinalWallet, type WalletInfo, type WalletConnector, type WindowLike, type XverseAddressResponse, type LeatherAddressResponse, type LeatherAddress, type LeatherBtcAddress, type LeatherStxAddress, } from './wallet/wallet.service.types';
export * from './cat21-mint/cat21.service.helper';
export * from './cat21-mint/cat21.service.types';
export * from './cat21-mint/cat21-mint.helper';
export * from './cat21-mint/cat21-mint-input-adapter';
export * from './cat21-fee/fee-simulation.helper';
export * from './cat21-fee/coin-selection.helper';
export * from './cat21-fee/dummy-keypair';
export * from './cat21-transfer/cat21-transfer.helper';
export * from './cat21-transfer/cat21-transfer.types';
export * from './cat21-transfer/cat21-transfer-input-adapter';
export * from './cat21-offer/cat21-offer.helper';
export * from './cat21-offer/cat21-offer.types';
export * from './cat21-offer/cat21-offer-input-adapter';
export * from './cat21-broadcast/broadcast.helper';
export * from './cat21-broadcast/slipstream.helper';
export * from './cat21-share/permalink.helper';
export * from './inscribe/inscription-envelope';
export * from './inscribe/inscription-commit.helper';
export * from './inscribe/inscription-reveal.helper';
export * from './inscribe/inscription-input-adapter';
export * from './inscribe/inscription-fee.helper';
export * from './inscribe/inscription.service.helper';
export * from './inscribe/inscribe-broadcast.helper';
export * from './inscribe/inscribe-orchestrator';
export * from './inscribe/inscribe-brotli.helper';
export * from './agent-mode/agent-policy.helper';
export * from './agent-mode/agent-policy.types';
export * from './cat21-validation';
export * from './inscribe-validation';
//# sourceMappingURL=core.d.ts.map