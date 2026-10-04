/**
 * Errors an inscribe UI shows to a person, as opposed to the internal
 * asserts and type checks a developer sees.
 *
 * Each carries a stable `code` (branch on it, or map it to your own copy),
 * a `userMessage` written for a person, and the numbers behind it in
 * `details`. `message` stays the developer-facing text, so logs and existing
 * error handling are unchanged.
 */

/** What went wrong, stable across releases. */
export type InscribeErrorCode =
  | 'insufficient-funds'
  | 'invalid-inscription-id'
  | 'duplicate-gallery-item'
  | 'duplicate-trait'
  | 'invalid-trait-value'
  | 'invalid-json-metadata'
  | 'properties-conflict'
  | 'body-or-delegate-required'
  | 'output-below-dust'
  | 'sat-offset-outside-utxo'
  | 'sat-offset-needs-padding'
  | 'padding-not-needed'
  | 'sat-utxo-must-be-taproot'
  | 'sat-utxo-key-mismatch'
  | 'no-padding-coin-available'
  | 'parent-not-found'
  | 'parent-not-owned'
  | 'parent-must-be-taproot'
  | 'reveal-too-heavy'
  | 'properties-too-large'
  | 'property-compression-ratio'
  | 'brotli-wasm-missing'
  | 'sat-utxo-must-be-selected'
  | 'batch-empty'
  | 'batch-destination-not-allowed'
  | 'batch-satpoint-required'
  | 'batch-satpoint-not-allowed'
  | 'batch-duplicate-satpoint'
  | 'batch-postage-not-allowed'
  | 'batch-sat-offset-not-allowed'
  | 'unsupported-payment-address'
  // Broadcast of the commit + reveal pair (`broadcastCommitAndReveal`).
  | 'package-check-unavailable'
  | 'package-rejected'
  | 'package-not-accepted'
  | 'reveal-pending';

export class InscribeInputError extends Error {
  readonly code: InscribeErrorCode;
  /** Written for the person inscribing; safe to show as it is. */
  readonly userMessage: string;
  /** The values behind the message, for a UI that words it itself. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: InscribeErrorCode,
    message: string,
    userMessage: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'InscribeInputError';
    this.code = code;
    this.userMessage = userMessage;
    this.details = details;
  }
}

/**
 * The commit may have reached a mempool but the reveal did not, after retries.
 *
 * The commit output can only be spent with the ephemeral key, so this error is
 * the one place the SDK hands that key out: `revealHex` is the fully signed
 * reveal and can be rebroadcast as it is; `ephemeral` lets a recovery tool spend
 * the commit output another way. Persist both until the reveal confirms.
 */
export class InscribeRevealPendingError extends InscribeInputError {
  readonly commitTxId: string;
  readonly revealTxId: string;
  readonly commitAddress: string;
  readonly revealHex: string;
  readonly ephemeral: { privKey: Uint8Array; pubkeyXonly: Uint8Array };

  constructor(recovery: {
    commitTxId: string;
    revealTxId: string;
    commitAddress: string;
    revealHex: string;
    ephemeral: { privKey: Uint8Array; pubkeyXonly: Uint8Array };
    reason: string;
  }) {
    super(
      'reveal-pending',
      `commit ${recovery.commitTxId} may be in a mempool, reveal ${recovery.revealTxId} is not: ${recovery.reason}`,
      'Your payment may already be on its way, but the inscription transaction was not accepted. Nothing is lost while the signed transaction is kept: keep this page open and send it again.',
      { commitTxId: recovery.commitTxId, revealTxId: recovery.revealTxId, reason: recovery.reason },
    );
    this.name = 'InscribeRevealPendingError';
    this.commitTxId = recovery.commitTxId;
    this.revealTxId = recovery.revealTxId;
    this.commitAddress = recovery.commitAddress;
    this.revealHex = recovery.revealHex;
    this.ephemeral = recovery.ephemeral;
  }
}

/** Throw an {@link InscribeInputError}; `message` keeps the developer wording. */
export function failInscribe(
  code: InscribeErrorCode,
  message: string,
  userMessage: string,
  details: Record<string, unknown> = {},
): never {
  throw new InscribeInputError(code, message, userMessage, details);
}

/** The user-facing message of an error, or its plain message when it is not one of ours. */
export function inscribeUserMessage(err: unknown): string {
  if (err instanceof InscribeInputError) return err.userMessage;
  return err instanceof Error ? err.message : String(err);
}
