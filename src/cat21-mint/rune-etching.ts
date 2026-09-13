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
 * What ord knows about a rune's etching. The four cases differ in whether the
 * answer can ever change, which is what a caller needs in order to cache
 * correctly:
 *
 *   - `etched` and `not-etched` are PERMANENT. A rune is etched once, and a
 *     rune the protocol reserves is never etched at all. Both are safe to keep
 *     forever.
 *   - `unknown` means ord has no entry for the name. That can change: the rune
 *     may be etched in a later block. Safe to keep briefly, not forever.
 *   - `unavailable` is not an answer. Never keep it, or one outage becomes a
 *     permanently dead row.
 */
export type RuneEtching =
  /** Etched by this transaction. */
  | { kind: 'etched'; txid: string }
  /**
   * The rune exists but was never etched by a transaction, so there is nothing
   * to link to. ord reports an all-zero etching for these. UNCOMMON•GOODS is
   * the one that matters: the runes protocol reserves it, and it is the rune
   * most likely to be sitting on a coin.
   */
  | { kind: 'not-etched' }
  /** ord has no entry for this name. */
  | { kind: 'unknown' }
  /** The lookup did not complete. Retry; do not remember this. */
  | { kind: 'unavailable' };

/**
 * Ask ord about a rune's etching, keeping the cases apart.
 *
 * {@link resolveRuneEtchingTxid} answers the narrower question and collapses
 * everything that is not a txid into `null`. That is enough to render a row,
 * but it hides which answers are permanent, so a caller obeying the
 * never-cache-a-miss rule re-asks forever for a rune that will never have an
 * etching. Use this one wherever the answer is cached.
 *
 * A response whose shape is not understood reads as `unavailable`, not as a
 * confident answer, because a wrong txid on a money-path row is worse than a
 * retry. Know the shape that choice makes, though: if an upstream ever starts
 * emitting a subtly different body, EVERY rune row goes unlinked and is
 * retried on every scan, indefinitely, and nothing fails while it happens.
 * Rune links going quiet everywhere at once, with no errors, is what that
 * looks like from the outside.
 */
export async function lookupRuneEtching(
  runeName: string,
  options: ResolveRuneEtchingOptions,
): Promise<RuneEtching> {
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
    if (res.status === 404) return { kind: 'unknown' };
    if (!res.ok) return { kind: 'unavailable' };

    const body = (await res.json()) as { entry?: { etching?: unknown } };
    const etching = body.entry?.etching;
    if (typeof etching !== 'string') return { kind: 'unavailable' };
    return isNullTxid(etching) ? { kind: 'not-etched' } : { kind: 'etched', txid: etching };
  } catch {
    return { kind: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
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
 * Does no caching of its own. Each consumer already has a layer to do it in,
 * and a library-level cache would be global state with the wrong lifetime.
 *
 * Cache a txid freely. Do NOT cache this function's `null`: it covers a
 * permanent answer and a transient failure alike, so keeping it would freeze
 * an outage into a dead row, and discarding it re-asks forever about a rune
 * that will never have an etching. When the answer is cached, call
 * {@link lookupRuneEtching} instead, which says which case it is.
 */
export async function resolveRuneEtchingTxid(
  runeName: string,
  options: ResolveRuneEtchingOptions,
): Promise<string | null> {
  const result = await lookupRuneEtching(runeName, options);
  return result.kind === 'etched' ? result.txid : null;
}

/** The all-zero txid ord reports for a rune that was never etched. */
function isNullTxid(txid: string): boolean {
  return /^0{64}$/.test(txid);
}
