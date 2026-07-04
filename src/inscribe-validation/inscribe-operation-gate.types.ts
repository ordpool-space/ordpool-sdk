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

import { type Network } from '../network';

/* ──────────────────────────  Intent shape  ────────────────────────── */

/**
 * Intent shape for an ord-protocol inscription. The user/agent
 * declares the body bytes + content type + recipient + fee rate;
 * the SDK builds commit + reveal via `createInscribeTransactions`.
 *
 * NOT a cat21 operation. The wire-format outcome is two regular
 * Bitcoin txs (lockTime=0) carrying an ord envelope in the reveal
 * tx's witness — no `nLockTime=21`, no CAT-21 cat produced.
 */
export interface InscribeIntent {
  /** Where the inscription lands (P2TR recommended). */
  recipient: string;
  /** sat/vB target (applied identically to commit + reveal). */
  feeRate: number;
  /**
   * Body bytes. The cap is `maxContentBytes` from config (default
   * 350_000 — keeps the reveal under standard relay).
   */
  body: Uint8Array;
  /**
   * MIME type embedded in the envelope. The gate enforces the
   * `allowedContentTypes` allowlist (when configured) and the
   * `blockedContentTypes` blocklist defensive filter.
   */
  contentType?: string;
  /**
   * Optional reveal-tx tip output. The gate validates the address on
   * the configured network and the value against the dust floor +
   * `maxTipValueSats` cap. Zero is treated as "no tip".
   *
   * The most policy-sensitive optional — an autonomous agent path
   * without a cap could drain a wallet by inflating `tip.value`.
   */
  tip?: { address: string; value: number };
  /** Optional Tag::Note (0x0f) UTF-8 watermark; capped at `maxNoteBytes`. */
  note?: string;
  /** Optional parent inscription id (`<txid>i<index>`). */
  parent?: string;
  /** Optional body-encoding hint (must be `'br'` if present). */
  contentEncoding?: 'br';
}

/**
 * Discriminated union over the inscribe-side operations the gate
 * validates. One variant today (`'inscribe'`); the shape is a
 * discriminated union so a future variant (RBF-the-reveal, etc.)
 * can land without rewriting the caller-side dispatch.
 */
export type InscribeOperation =
  | { kind: 'inscribe'; intent: InscribeIntent };

/* ──────────────────────────  Config shape  ────────────────────────── */

export interface InscribeOperationGateConfig {
  /** Active network. Address checks key off this. */
  network: Network;

  /**
   * Hard ceiling on fee rate. Recommend 1000 sat/vB as a "you typed
   * something wrong" backstop. When unset, only `feeRate > 0` is
   * enforced.
   */
  maxFeeRatePerVbyte?: number;

  /**
   * Wallet's own payment address. When provided, the gate rejects
   * an inscription whose recipient matches it (self-send guard).
   */
  ownPaymentAddress?: string;

  /**
   * Positive recipient allowlist. When set and non-empty, the
   * recipient MUST be in the list.
   */
  allowedRecipients?: ReadonlyArray<string>;

  /**
   * Maximum inscription body size in bytes. Default 350_000.
   * Larger bodies are a Phase-3 Slipstream concern.
   */
  maxContentBytes?: number;

  /**
   * Positive content-type allowlist (exact case-insensitive match).
   * When unset/empty → any well-formed contentType permitted.
   *
   * Recommended day-one allowlist: image/png, image/jpeg,
   * image/svg+xml, image/webp, image/gif, text/plain, text/html,
   * application/json, application/cbor.
   */
  allowedContentTypes?: ReadonlyArray<string>;

  /**
   * Defensive content-type blocklist. Wins over the allowlist
   * (defence in depth against a misconfigured allowlist).
   *
   * Recommended day-one blocklist: 'application/javascript',
   * 'text/javascript', 'application/x-javascript' (XSS-flavoured
   * inscribers).
   */
  blockedContentTypes?: ReadonlyArray<string>;

  /**
   * Hard ceiling on `tip.value` in sats. Recommended for autonomous
   * flows (drain protection). When unset, only the dust-floor + integer
   * checks apply.
   */
  maxTipValueSats?: number;

  /**
   * Positive tip-address allowlist. When set and non-empty, the tip
   * MUST go to a listed address. Practical for automated flows where
   * the tip beneficiary is fixed.
   */
  allowedTipAddresses?: ReadonlyArray<string>;

  /** Maximum note bytes (UTF-8). Default 128. */
  maxNoteBytes?: number;
}

/* ──────────────────────────  Result shapes  ────────────────────────── */

export type InscribeGateRejectReason =
  // Generic shape errors
  | 'intent-not-an-object'
  | 'unsupported-operation-kind'

  // Recipient address validation
  | 'recipient-not-a-bitcoin-address'
  | 'recipient-wrong-network'
  | 'recipient-not-allowed'
  | 'self-send'

  // Fee rate
  | 'fee-rate-not-finite-number'
  | 'fee-rate-not-positive'
  | 'fee-rate-not-integer'
  | 'fee-rate-above-cap'

  // Inscribe-specific
  | 'content-not-bytes'
  | 'content-too-large'
  | 'content-type-not-string'
  | 'content-type-not-allowed'
  | 'content-type-blocked'

  // Tip
  | 'tip-not-an-object'
  | 'tip-address-not-a-bitcoin-address'
  | 'tip-address-wrong-network'
  | 'tip-address-not-allowed'
  | 'tip-value-not-finite-number'
  | 'tip-value-not-integer'
  | 'tip-value-negative'
  | 'tip-value-below-dust'
  | 'tip-value-above-cap'

  // Note
  | 'note-not-a-string'
  | 'note-too-large'

  // Parent
  | 'parent-malformed'

  // Content encoding
  | 'content-encoding-invalid';

export type InscribeGateResources = {
  kind: 'inscribe';
  recipientScript: Uint8Array;
  /** Validated content bytes — same object the caller passed. */
  contentBytes: Uint8Array;
  /** Normalised contentType (lowercased) when present. */
  contentType: string | undefined;
  /**
   * Pre-decoded tip when supplied and non-zero. Downstream builders
   * pass `tipScript`/`tipValueSats` straight into the reveal builder
   * without re-decoding the address.
   */
  tip?: { address: string; tipScript: Uint8Array; tipValueSats: number };
  /** Validated + length-checked note UTF-8 bytes, when supplied. */
  noteBytes?: Uint8Array;
  /** Pre-encoded parent tag value (reversed txid + LE-trimmed index), when supplied. */
  parentBytes?: Uint8Array;
  /** Validated content encoding when supplied. Only `'br'` today. */
  contentEncoding?: 'br';
};

export type InscribeOperationGateResult =
  | { ok: true; resources: InscribeGateResources }
  | { ok: false; reason: InscribeGateRejectReason; detail?: string };
