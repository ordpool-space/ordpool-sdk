/**
 * The cat number of one CAT-21 cat, from cat21-ord's
 * `GET /inscription/<id>` (`number`). cat21-ord indexes only cats, so its
 * inscription number is the cat number.
 *
 * Resolves `null` when the lookup fails or answers without an integer
 * `number`. The number is for display: its absence must never turn a scan that
 * found a cat into a failed one.
 *
 * Only a real inscription id (`<64 hex>i<n>`) is asked for, and the answer
 * counts only when its `id` is that id. cat21-ord also resolves
 * `/inscription/<number>`: a malformed id such as "0" would come back as
 * another cat's record, and the UI would name a cat that is not on the coin.
 */
/** An inscription id as cat21-ord spells it: 64 hex txid, `i`, index. */
const INSCRIPTION_ID = /^[0-9a-f]{64}i\d+$/;

export async function lookupCatNumber(
  cat21OrdApiUrl: string,
  inscriptionId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<number | null> {
  if (!INSCRIPTION_ID.test(inscriptionId)) return null;
  const url = `${cat21OrdApiUrl.replace(/\/+$/, '')}/inscription/${inscriptionId}`;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: opts.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { id?: unknown; number?: unknown };
    if (body.id !== inscriptionId) return null;
    return typeof body.number === 'number' && Number.isSafeInteger(body.number) ? body.number : null;
  } catch {
    return null;
  }
}
