import { Cat21Listing } from './cat21-listing.types';

/**
 * Canonical listing-message format version. Bump when the field set,
 * order, or separator changes so old signatures don't accidentally
 * verify against a new-shape message (or vice versa).
 */
export const CAT21_LISTING_MESSAGE_VERSION = 'v1';

/**
 * The fields the listing message covers, in the fixed canonical
 * order. Every consumer (seller's wallet during signing, backend
 * during verification, external mirror during re-verification)
 * builds the message via `buildListingMessage()` — never
 * concatenates fields directly.
 */
export type ListingMessageFields = Pick<
  Cat21Listing,
  'catNumber' | 'askSats' | 'payTo' | 'catTxid' | 'catVout' | 'ordinalsAddress' | 'signedAt'
>;

/**
 * Build the canonical human-readable message the seller signs with
 * their ordinals wallet. Multi-line by design — the wallet's
 * signature prompt renders this as-is, and the seller reads it
 * before approving. Fixed order, fixed separator, fixed prefix.
 *
 * Any drift between the seller's version and the verifier's version
 * (added field, reordered line, changed separator) breaks the
 * signature. The version prefix (`cat21-ask:v1`) is the escape
 * hatch: bump when the schema changes so old + new signatures don't
 * confuse the verifier.
 *
 * Example message the seller sees in their wallet:
 *
 * ```
 * cat21-ask:v1
 * catNumber=42
 * askSats=21000
 * payTo=bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx
 * catTxid=ab49227cce490e2137872f7d08924187ee4f4bc7e8b3bda7ac63d7bba1d897df
 * catVout=0
 * ordinalsAddress=bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9
 * signedAt=1700000000
 * ```
 */
export function buildListingMessage(fields: ListingMessageFields): string {
  assertPositiveInt(fields.catNumber, 'catNumber');
  assertPositiveInt(fields.askSats, 'askSats');
  assertNonNegativeInt(fields.catVout, 'catVout');
  assertPositiveInt(fields.signedAt, 'signedAt');
  if (!fields.payTo || typeof fields.payTo !== 'string') {
    throw new Error('payTo must be a non-empty string');
  }
  if (!fields.ordinalsAddress || typeof fields.ordinalsAddress !== 'string') {
    throw new Error('ordinalsAddress must be a non-empty string');
  }
  if (!/^[0-9a-f]{64}$/.test(fields.catTxid)) {
    throw new Error(`catTxid must be 64-char lowercase hex; got ${JSON.stringify(fields.catTxid)}`);
  }
  return [
    `cat21-ask:${CAT21_LISTING_MESSAGE_VERSION}`,
    `catNumber=${fields.catNumber}`,
    `askSats=${fields.askSats}`,
    `payTo=${fields.payTo}`,
    `catTxid=${fields.catTxid}`,
    `catVout=${fields.catVout}`,
    `ordinalsAddress=${fields.ordinalsAddress}`,
    `signedAt=${fields.signedAt}`,
  ].join('\n');
}

function assertPositiveInt(n: number, name: string): void {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer; got ${n}`);
  }
}

function assertNonNegativeInt(n: number, name: string): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer; got ${n}`);
  }
}
