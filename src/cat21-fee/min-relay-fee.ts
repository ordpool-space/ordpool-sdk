/**
 * Bitcoin Core's default minimum relay fee rate, in sat/vByte.
 *
 * A transaction paying below this rate is rejected by a default-configured
 * node's mempool, so it is the floor a fee picker should offer / a fee
 * estimate should clamp to.
 *
 * Source: Bitcoin Core `DEFAULT_MIN_RELAY_TX_FEE` in `src/policy/policy.h`,
 * expressed in sat per 1000 vB. Verified against the tagged Core source:
 *   - v27.0 / v28.0 / v29.0 = 1000  (=> 1 sat/vB)
 *   - v29.1 / master        =  100  (=> 0.1 sat/vB)
 * Core lowered it from 1000 to 100 in v29.1. 100 sat/kvB / 1000 = 0.1 sat/vB.
 */
export const BITCOIN_MIN_RELAY_FEE_SAT_PER_KVB = 100;

/** {@link BITCOIN_MIN_RELAY_FEE_SAT_PER_KVB} as sat/vByte (100 / 1000). */
export const BITCOIN_MIN_RELAY_FEE_SAT_PER_VBYTE = BITCOIN_MIN_RELAY_FEE_SAT_PER_KVB / 1000;
