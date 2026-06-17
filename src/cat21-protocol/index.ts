/**
 * Protocol-wide CAT-21 invariants. Used by every cat-touching flow
 * (mint, transfer, offer), no flow-specific code lives here.
 *
 *   - `CAT21_POSTAGE_SATS` — cat UTXO is always 546 sats (HARD RULE).
 *   - `CAT21_LOCK_TIME` + `assertCat21LockTime` — every cat-touching
 *     tx OUR code builds carries `nLockTime = 21`.
 *   - `resolveCat21InputSequence` + the two sequence constants — the
 *     per-wallet RBF policy (cat21wallet → RBF on, every other
 *     wallet → RBF off).
 */
export * from './cat21-postage';
export * from './cat21-lock-time';
export * from './cat21-sequence';
