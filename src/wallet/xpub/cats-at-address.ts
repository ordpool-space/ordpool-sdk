/**
 * Cat-at-address lookup (the CAT-21 half of watch-only ordinals-safety).
 *
 * A watch-only scan derives a run of receive addresses and must decide
 * which one carries the wallet's cat, so the ordinals identity is the
 * cat-bearing address rather than a blind receive index 0 (the Genesis
 * Cat is not at index 0). Ownership follows the sat, so the only honest
 * answer to "does this address hold a CAT-21 cat" comes from a cat index,
 * never a UTXO-size heuristic.
 *
 * This helper reads it from cat21-ord's address index. cat21-ord runs
 * with `--index-cat21 --index-addresses` at `ord.cat21.space`, and its
 * `GET /address/{address}` returns (real response, verified):
 *
 *   { outputs: string[],          // "txid:vout" outpoints
 *     cats: string[],             // cat inscription ids "…i0"  (serde-renamed
 *                                 //   from the Rust `inscriptions` field)
 *     cat_numbers: number[]|null, // the CAT-21 cat numbers, e.g. [27, 10, 9]
 *     sat_balance: number,
 *     runes_balances: … | null }
 *
 * `cat_numbers` is the canonical CAT-21 answer, so that is what we read.
 *
 * MUST target cat21-ord (`--index-cat21`), NOT the full ord at
 * `ord.ordpool.space`: the full ord indexes real inscriptions and does
 * not number cats, so it cannot answer cat membership. The caller passes
 * `cat21OrdApiUrl` explicitly so the two ord instances can't be miswired.
 *
 * Pure + Angular-free (`/core`): native `fetch` + an optional
 * `AbortSignal`, no axios.
 */

export interface CatsAtAddressOptions {
  /**
   * Base URL of a cat21-ord instance (`--index-cat21 --index-addresses`),
   * e.g. `https://ord.cat21.space`. A trailing slash is tolerated.
   */
  cat21OrdApiUrl: string;
  /** Optional signal to cancel the request. */
  signal?: AbortSignal;
}

/** The shape we read off cat21-ord's `/address/{address}` response. */
interface Cat21OrdAddressInfo {
  cat_numbers?: number[] | null;
}

/**
 * The CAT-21 cat numbers currently held at `address`, per cat21-ord's
 * address index. Empty array when the address holds no cats (including a
 * `404` for an address cat21-ord has never seen). Throws on any other
 * non-2xx status or a malformed body.
 */
export async function catsAtAddress(
  address: string,
  options: CatsAtAddressOptions,
): Promise<number[]> {
  const base = options.cat21OrdApiUrl.replace(/\/+$/, '');
  const url = `${base}/address/${encodeURIComponent(address)}`;

  const response = await fetch(url, {
    // cat21-ord runs with --disable-html: it answers only when the caller
    // asks for JSON, otherwise 406 before any index read.
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });

  // An address with no history is a legitimate "no cats", not an error.
  if (response.status === 404) return [];

  if (!response.ok) {
    throw new Error(`catsAtAddress: ${url} returned ${response.status}`);
  }

  const info = (await response.json()) as Cat21OrdAddressInfo;
  return info.cat_numbers ?? [];
}

/**
 * Whether `address` currently holds at least one CAT-21 cat, per
 * cat21-ord. Thin boolean wrapper over {@link catsAtAddress} for the
 * watch-only scan's `hasCat` probe field.
 */
export async function addressHoldsCat(
  address: string,
  options: CatsAtAddressOptions,
): Promise<boolean> {
  return (await catsAtAddress(address, options)).length > 0;
}
