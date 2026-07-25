/**
 * Session-token capability layer for cat21 marketplace operations.
 *
 * The idea: instead of prompting the user for a BIP-322 signature
 * on every capability action (delete listing, delete bid, future
 * my-cats view), prompt ONCE per session for a canonical message
 * of the form
 *
 *   `Cat21 session: I control <address>, valid until <ISO>`
 *
 * The client caches the signed message + signature in localStorage,
 * keyed by the ordinals address. Every subsequent capability request
 * attaches three headers (address, message, signature); the backend
 * verifies via BIP-322 and honours the request iff the timestamp is
 * still in the future AND the header address matches the target of
 * the action.
 *
 * Threat model: a session token is a bearer capability for the
 * validity window. It is intentionally SEPARATE from per-artifact
 * signatures (per-listing BIP-322, per-bid PSBT SIGHASH_ALL), which
 * remain the tamper-proof marketplace record. The session token is
 * ONLY used for actions whose intent doesn't need to survive
 * independently as a public artifact — namely deletes and future
 * "show me my stuff" reads.
 *
 * See workspace CLAUDE.md for the philosophical rationale: the
 * marketplace layer is convenience; the real security is PSBT +
 * Bitcoin as the ledger. A leaked session token can grief the
 * marketplace (spurious delete, spurious future-my-cats read) but
 * cannot cost anyone Bitcoin.
 */

/**
 * Default validity window. Long enough that most users won't hit an
 * expiry prompt in a normal browsing session; short enough that a
 * leaked token from a single-tab XSS doesn't stay valid for weeks.
 */
export const CAT21_SESSION_VALIDITY_MS = 24 * 60 * 60 * 1_000; // 24 hours

/**
 * Absolute cap so a caller can't hand-craft a session valid until
 * year 3000. Backend rejects `validUntil` further out than this.
 */
export const CAT21_SESSION_MAX_VALIDITY_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

/**
 * Build the canonical UTF-8 message the user signs to prove control
 * of `address` until `validUntilIso`.
 *
 * Deterministic — same inputs always produce the same bytes — so the
 * backend can rebuild the message from headers and hand it to
 * `verifyBip322Signature`.
 *
 * Format is a single line; the ISO-8601 timestamp uses second
 * precision (backend truncates any sub-second component on
 * comparison) so a wallet's local clock jitter can't produce a
 * different message than the one it signed.
 */
export function buildCat21SessionMessage(args: {
  address: string;
  validUntilIso: string;
}): string {
  return `Cat21 session: I control ${args.address}, valid until ${args.validUntilIso}`;
}

/**
 * Verify the ISO timestamp is well-formed AND still in the future.
 * Returns null on ok, or a reason string on failure. Callers use
 * this at both ends of the wire:
 *
 *   - client: skip a cached session whose `validUntilIso` is past
 *   - server: reject an incoming header with a past `validUntilIso`
 */
export function checkSessionValidity(validUntilIso: string, nowMs: number): null | 'malformed-timestamp' | 'session-expired' | 'session-too-far-in-future' {
  const t = Date.parse(validUntilIso);
  if (Number.isNaN(t)) return 'malformed-timestamp';
  if (t <= nowMs) return 'session-expired';
  if (t - nowMs > CAT21_SESSION_MAX_VALIDITY_MS) return 'session-too-far-in-future';
  return null;
}
