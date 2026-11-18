/**
 * The cat number of one CAT-21 cat, from cat21-ord's
 * `GET /inscription/<id>` (`number`). cat21-ord indexes only cats, so its
 * inscription number is the cat number.
 *
 * Resolves `null` when the lookup fails or answers without an integer
 * `number`. The number is for display: its absence must never turn a scan that
 * found a cat into a failed one.
 */
export async function lookupCatNumber(
  cat21OrdApiUrl: string,
  inscriptionId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<number | null> {
  const url = `${cat21OrdApiUrl.replace(/\/+$/, '')}/inscription/${inscriptionId}`;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: opts.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { number?: unknown };
    return typeof body.number === 'number' && Number.isSafeInteger(body.number) ? body.number : null;
  } catch {
    return null;
  }
}
