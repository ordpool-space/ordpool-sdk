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
  | 'unsupported-payment-address';

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
