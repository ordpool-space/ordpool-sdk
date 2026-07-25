import { buildListingMessage, ListingMessageFields } from './build-listing-message';
import { verifyBip322Signature } from '../wallet/verify-bip322-signature';

/**
 * Result of `verifyListingSignature`. On success, `ok: true` — the
 * BIP-322 signature is valid for the given ordinals address AND the
 * message it commits to matches the listing fields byte-for-byte.
 * On failure, `ok: false` with a `reason` code the caller (backend
 * insert path, frontend re-verifier) can log / show.
 */
export type VerifyListingSignatureResult =
  | { ok: true }
  | { ok: false; reason: VerifyListingRejectionReason; detail?: string };

export type VerifyListingRejectionReason =
  | 'malformed-signature'         // base64 / structure decode failed
  | 'unsupported-address-type'    // BIP-322 verify supports P2TR only in v1
  | 'invalid-address'             // ordinalsAddress doesn't decode as a Bitcoin address
  | 'signature-does-not-verify';  // schnorr.verify returned false

/**
 * Verify a BIP-322 "simple" signature over the canonical listing
 * message, for a P2TR ordinals address.
 *
 * The BIP-322 primitive itself lives in
 * `../wallet/verify-bip322-signature.ts`; this function is the
 * listing-shaped wrapper that (a) rebuilds the canonical message
 * from the listing fields and (b) reuses the shared primitive.
 * The listing-shape validation (cats-bundle sanity, headline
 * membership, MAX_ASK_SATS) lives in `buildListingMessage` — a
 * caller who hands us structurally-broken fields cannot have a
 * signature that verifies against a canonical rebuild, so we
 * collapse a build-time throw into the same `signature-does-not-
 * verify` reason the caller already handles.
 */
export function verifyListingSignature(args: {
  fields: ListingMessageFields;
  signatureBase64: string;
}): VerifyListingSignatureResult {
  const { fields, signatureBase64 } = args;

  let message: string;
  try {
    message = buildListingMessage(fields);
  } catch {
    return { ok: false, reason: 'signature-does-not-verify' };
  }

  const result = verifyBip322Signature({
    address: fields.ordinalsAddress,
    message,
    signatureBase64,
  });

  // The two Result types have identical shapes and reason enums;
  // the cast is a no-op re-branding for consumers that expect the
  // listing-specific type name.
  return result as VerifyListingSignatureResult;
}
