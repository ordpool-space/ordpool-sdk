"use strict";
/**
 * Bulletproof gate types for the inscribe operation.
 *
 * Single entry point: `validateInscribeOperation({ config, operation })`
 * returns a discriminated `{ ok: true, resources } | { ok: false,
 * reason, detail? }`. Same shape as `validateCat21Operation` in
 * `cat21-validation/`, but a SEPARATE module by deliberate design:
 *
 *   - Inscribing an ord envelope (`<pubkey> CHECKSIG OP_FALSE OP_IF
 *     "ord" <tags> body OP_ENDIF`, lockTime=0) is a different
 *     on-chain-data protocol from CAT-21 (`nLockTime=21`, no
 *     envelope, no on-chain content). The validation surfaces stay
 *     separate so consumers can't accidentally mix them.
 *   - Inscribe consumers (cat21.space's future inscribe UI, a
 *     potential `ordpool-inscriber` tool) configure inscribe rules
 *     here. Cat21 consumers (cat21-wallet, cat21.space's mint flows)
 *     configure cat21 rules in `cat21-validation/`.
 *
 * Address / fee-rate validation primitives are duplicated rather
 * than shared with `cat21-validation/` so each gate's rejection-
 * reason union stays minimal and operation-named. If a third
 * Bitcoin operation lands and the same primitives surface for a
 * third time, extract them into a shared `bitcoin-validation/`
 * module at that point — YAGNI for now.
 *
 * Design rules:
 *   - Each rejection reason is one test case. No catch-all
 *     `'invalid-intent'` reasons.
 *   - The `resources` field on success carries pre-decoded values
 *     so the downstream builder doesn't re-decode.
 *   - Config is wholly optional except for `network`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=inscribe-operation-gate.types.js.map