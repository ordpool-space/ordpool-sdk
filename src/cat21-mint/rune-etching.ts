/**
 * A rune's name to the transaction that etched it.
 *
 * The funding-safety panel lists what a flagged coin carries, and a rune row
 * links to its etching transaction. A scanned output names its runes
 * (`runeNamesFromContent`) but carries no txid, so the name has to be resolved
 * against ord's `/rune/<name>`, whose `entry.etching` holds it.
 */

export interface ResolveRuneEtchingOptions {
  /** Base URL of an ord server with the JSON API, e.g. `https://ord.ordpool.space`. */
  ordBaseUrl: string;
  /** Per-request timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /** The fetch to use. Default the global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * The txid of the transaction that etched `runeName`, or `null` when there is
 * no transaction to link to.
 *
 * `null` covers three cases the caller renders the same way, as plain text
 * rather than a link:
 *
 *   - ord does not know the name (404), or the lookup failed;
 *   - the rune has no etching transaction. UNCOMMON•GOODS is the one that
 *     matters: it is reserved by the runes protocol rather than etched, so ord
 *     reports `etching` as the all-zero txid. Linking that produces a page for
 *     a transaction that does not exist, and it is the rune most likely to be
 *     on a coin, so the naive version breaks on the commonest row.
 *
 * Takes the name as ord spells it, including the `•` separators that
 * `runeNamesFromContent` returns; the name is URL-encoded here.
 *
 * Does no caching of its own. A name resolves to the same etching forever, so
 * caching is worth doing, but each consumer already has a layer to do it in
 * and a library-level cache would be global state with the wrong lifetime.
 * Cache a POSITIVE answer freely; do not cache a `null`, because a transient
 * outage would then become a permanently dead link.
 */
export async function resolveRuneEtchingTxid(
  runeName: string,
  options: ResolveRuneEtchingOptions,
): Promise<string | null> {
  const base = options.ordBaseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const res = await (options.fetchFn ?? fetch)(`${base}/rune/${encodeURIComponent(runeName)}`, {
      // ord.ordpool.space answers JSON but refuses HTML with 406, so this is
      // load-bearing rather than decorative.
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null; // unknown rune (404) or a failed lookup

    const body = (await res.json()) as { entry?: { etching?: unknown } };
    const etching = body.entry?.etching;
    return typeof etching === 'string' && !isNullTxid(etching) ? etching : null;
  } catch {
    return null; // network error or timeout
  } finally {
    clearTimeout(timer);
  }
}

/** The all-zero txid ord reports for a rune that was never etched. */
function isNullTxid(txid: string): boolean {
  return /^0{64}$/.test(txid);
}
