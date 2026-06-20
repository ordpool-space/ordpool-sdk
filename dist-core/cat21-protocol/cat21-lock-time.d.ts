/**
 * The CAT-21 protocol marker. Every cat-touching tx OUR code builds
 * carries `nLockTime = 21`. cat21-ord reads the field structurally
 * (no consensus enforcement — block 21 was mined in 2009, so the
 * constraint is trivially satisfied) and mints a fresh cat at the
 * first sat of the first output.
 *
 * Used by the mint builder (creates a cat from nothing), the
 * transfer builder (carries the existing cat AND mints a fresh one
 * on the same ordinal — the cherry on top), and the buy-offer
 * builder (offer-acceptance tx is also a mint by the same rule).
 *
 * The number `21` is data, not a time-lock. See SDK CLAUDE.md
 * HARD RULE "CAT-21 mints — RBF policy (per-wallet)" for the full
 * story plus the per-wallet sequence interaction.
 */
export declare const CAT21_LOCK_TIME = 21;
/**
 * Hard runtime assertion. Every Layer-1 builder calls this after
 * constructing its scure `Transaction` and before returning bytes.
 * A diverging lockTime means the constructor was passed something
 * other than `CAT21_LOCK_TIME`, which is a load-bearing-bug-class
 * mistake (cat21-ord wouldn't mint the cat).
 */
export declare function assertCat21LockTime(lockTime: number): void;
//# sourceMappingURL=cat21-lock-time.d.ts.map