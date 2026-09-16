/**
 * `ordpool-sdk/inscribe-fee` — what an inscription will cost, before anything
 * is signed.
 *
 * Its own subpath because this is the pre-wallet surface: a page showing "this
 * inscription costs N sats" has no wallet connected yet, so making it import
 * the package barrel meant shipping the wallet connectors and their dependency
 * cluster to answer an arithmetic question.
 *
 * These simulate against real PSBT construction rather than estimating from a
 * table, which is why they carry `@scure/btc-signer`: the workspace rule is
 * that a vbyte count comes from a built transaction, never from a
 * `TYPICAL_*_VBYTES` constant.
 */
export {
  simulateInscribeFees,
  type SimulateInscribeFeesArgs,
  type SimulateInscribeFeesResult,
} from '../inscribe/inscription-fee.helper.js';
export { simulateBatchInscribeFees } from '../inscribe/inscription-batch.helper.js';
