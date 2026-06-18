/**
 * Bitcoin / per-wallet script construction helpers, used across the
 * CAT-21 pipeline. No flow-specific code lives here — every consumer
 * (mint, transfer, offer) and the cat21.space orchestrator all reach
 * into this folder for address-format detection + per-wallet script
 * assembly.
 */
export * from './address-format';
export * from './build-input-script';
// Per-wallet-scripts.ts is retained as a transitional shim — existing
// consumers (cat21.space frontend, possibly third-party) may still
// import `createInputScriptFor{Leather,Xverse,Unisat}`. The Layer-2
// adapters now dispatch on address format via `buildInputScript`
// instead.
export * from './per-wallet-scripts';
