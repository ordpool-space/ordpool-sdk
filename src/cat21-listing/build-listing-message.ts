import { Network } from '../network';
import { Cat21Listing, MAX_ASK_SATS } from './cat21-listing.types';

/**
 * Canonical listing-message format version. Bump when the field set,
 * order, or separator changes so old signatures don't accidentally
 * verify against a new-shape message (or vice versa).
 *
 * v3 (2026-07-22): the load-bearing identifier for a listing is the
 * cat UTXO (`catTxid:catVout`) plus the FULL set of cats that ride
 * on it. `cats` line added; `catNumber` stays as the presentational
 * headline (lowest number in the bundle). Hard break from v2 —
 * v2 signatures never verify under v3.
 */
export const CAT21_LISTING_MESSAGE_VERSION = 'v3';

/**
 * The fields the listing message covers, in the fixed canonical
 * order. Every consumer (seller's wallet during signing, backend
 * during verification, external mirror during re-verification)
 * builds the message via `buildListingMessage()` — never
 * concatenates fields directly.
 */
export type ListingMessageFields = Pick<
  Cat21Listing,
  'catNumber' | 'cats' | 'network' | 'askSats' | 'payTo' | 'catTxid' | 'catVout' | 'ordinalsAddress' | 'signedAt'
>;

/**
 * Serialise a Network value for the canonical message line. Fixed
 * strings so a rename to the Network enum can't silently change the
 * signed bytes.
 */
function networkTag(n: Network): string {
  switch (n) {
    case Network.Mainnet: return 'mainnet';
    case Network.Testnet3: return 'testnet3';
    case Network.Testnet4: return 'testnet4';
    case Network.Regtest: return 'regtest';
    default: throw new Error(`Unknown network: ${n as string}`);
  }
}

/**
 * Build the canonical human-readable message the seller signs with
 * their ordinals wallet. Multi-line by design — the wallet's
 * signature prompt renders this as-is, and the seller reads it
 * before approving. Fixed order, fixed separator, fixed prefix.
 *
 * Any drift between the seller's version and the verifier's version
 * (added field, reordered line, changed separator) breaks the
 * signature. The version prefix (`cat21-ask:vN`) is the escape
 * hatch: bump when the schema changes so old + new signatures don't
 * confuse the verifier.
 *
 * Example message the seller sees in their wallet:
 *
 * ```
 * cat21-ask:v3
 * network=mainnet
 * catNumber=42
 * cats=42,100,500
 * askSats=21000
 * payTo=bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx
 * catTxid=ab49227cce490e2137872f7d08924187ee4f4bc7e8b3bda7ac63d7bba1d897df
 * catVout=0
 * ordinalsAddress=bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9
 * signedAt=1700000000
 * ```
 */
export function buildListingMessage(fields: ListingMessageFields): string {
  // catNumber allows 0 — the Genesis Cat (cat #0) is a real, indexable,
  // owned UTXO like any other cat. Per the workspace HARD RULE "The
  // Genesis Cat's price tag is 21 BTC" its lore-fixed askSats is 21 BTC
  // (2_100_000_000 sats). Nothing in the protocol makes cat #0
  // untransferable; blocking it from listings would just prevent the
  // one canonical Genesis-Cat listing from ever being signed.
  assertNonNegativeInt(fields.catNumber, 'catNumber');
  assertPositiveInt(fields.askSats, 'askSats');
  if (fields.askSats > MAX_ASK_SATS) {
    throw new Error(`askSats must not exceed MAX_ASK_SATS (${MAX_ASK_SATS}); got ${fields.askSats}`);
  }
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
  // cats: canonicalise before emitting — buyer sees the same bytes
  // regardless of what order the seller's UI passed them in. Sorted
  // ascending, deduped, non-negative integers, non-empty, catNumber
  // must be a member (the headline is IN the bundle).
  const catsLine = serializeCats(fields.cats, fields.catNumber);
  // networkTag throws on unknown enum values — surface before the message emits.
  const networkLine = networkTag(fields.network);
  return [
    `cat21-ask:${CAT21_LISTING_MESSAGE_VERSION}`,
    `network=${networkLine}`,
    `catNumber=${fields.catNumber}`,
    `cats=${catsLine}`,
    `askSats=${fields.askSats}`,
    `payTo=${fields.payTo}`,
    `catTxid=${fields.catTxid}`,
    `catVout=${fields.catVout}`,
    `ordinalsAddress=${fields.ordinalsAddress}`,
    `signedAt=${fields.signedAt}`,
  ].join('\n');
}

/**
 * Canonicalise + validate the `cats` bundle. Ascending sort + dedup
 * so the seller's signed bytes are the same regardless of the order
 * their UI hands them over. Emits comma-separated: `0,42,100`.
 *
 * `catNumber` (the headline) MUST be one of the bundle entries —
 * displaying a headline that isn't in the bundle would let a seller
 * hide the fact that the UTXO also carries a lower-numbered cat.
 */
export function serializeCats(cats: number[], headlineCatNumber: number): string {
  if (!Array.isArray(cats) || cats.length === 0) {
    throw new Error('cats must be a non-empty array of cat numbers');
  }
  for (const c of cats) {
    if (!Number.isInteger(c) || c < 0) {
      throw new Error(`cats entries must be non-negative integers; got ${c}`);
    }
  }
  const sorted = Array.from(new Set(cats)).sort((a, b) => a - b);
  if (sorted[0] !== headlineCatNumber && !sorted.includes(headlineCatNumber)) {
    throw new Error(
      `headline catNumber ${headlineCatNumber} must be a member of cats [${sorted.join(',')}]`,
    );
  }
  return sorted.join(',');
}

/**
 * Parse the `cats=` line of a canonical listing message back into a
 * sorted, deduped number array. Inverse of serializeCats — used by
 * external mirrors verifying signatures without a full backend.
 */
export function parseCatsList(csv: string): number[] {
  if (!csv || typeof csv !== 'string') {
    throw new Error('cats line must be a non-empty string');
  }
  const parts = csv.split(',');
  const nums: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`cats line contains non-integer or negative entry: ${JSON.stringify(p)}`);
    }
    nums.push(n);
  }
  return nums;
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
