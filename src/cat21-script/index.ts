/**
 * Bitcoin / per-wallet script construction helpers, used across the
 * CAT-21 pipeline. No flow-specific code lives here — every consumer
 * (mint, transfer, offer) and the cat21.space orchestrator all reach
 * into this folder for address-format detection + per-wallet script
 * assembly.
 */
export * from './address-format';
export * from './per-wallet-scripts';
