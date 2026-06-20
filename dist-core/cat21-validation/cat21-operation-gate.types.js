/**
 * Bulletproof gate types for the four cat21 mutating operations.
 *
 * Single entry point: `validateCat21Operation({ config, operation })`
 * returns a discriminated `{ ok: true, resources } | { ok: false,
 * reason, detail? }`. This replaces every per-flow "invariants"
 * module that consumers used to maintain themselves.
 *
 * Design rules:
 *   - Each rejection reason is one test case. No catch-all
 *     `'invalid-intent'` reasons; every shape of malformed input
 *     gets a named reason the consumer can dispatch on.
 *   - The `resources` field on success carries pre-decoded values
 *     (recipient scriptPubKey, parsed catId pieces, ...) so the
 *     downstream builder / rpc-service doesn't re-decode. One pass
 *     of `btc.Address(...).decode(...)` per field, not three.
 *   - Config is wholly optional except for `network`. Consumers that
 *     don't want caps can pass `{ network }`; consumers that want
 *     wallet-policy caps pass `maxFeeRatePerVbyte`, etc.
 *   - No `Validated<I>` brand. Type narrowing happens via the
 *     discriminated union return type, which is a runtime witness
 *     the gate produced.
 */
export {};
//# sourceMappingURL=cat21-operation-gate.types.js.map