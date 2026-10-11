/**
 * Which CAT-21 cats ride on one output, read from a cat21-ord instance
 * (`--index-cat21`).
 *
 * cat21-ord's `GET /output/<txid>:<vout>` lists the cats on the output in its
 * `cats` field as inscription ids (`<txid>i<n>`, the Rust `inscriptions` field
 * serde-renamed), never as cat numbers. Each id resolves through
 * `GET /inscription/<id>`, whose `number` is the cat number: cat21-ord indexes
 * nothing but cats, so its inscription numbering IS the cat numbering, the same
 * `inscription_number` its `/address` index returns as `cat_numbers` (an i32;
 * a cursed entry is negative and is kept, as there). Shapes:
 * `cat21OrdOutputWithCatFixture`, `cat21OrdOutputWithoutCatsFixture`,
 * `cat21OrdCatInscriptionFixture` (captured from cat21-ord).
 *
 * The answer feeds a listing check (the cats a seller signed for against the
 * cats on the output now), so every shape it does not expect fails loudly
 * instead of shrinking the list: a cat dropped from the answer reads as "the
 * bundle changed" or, worse, as "nothing here".
 *
 * No host is built in: the caller hands in a {@link Cat21OrdReader}, usually
 * {@link cat21OrdFetchReader} over its own cat21-ord base URL.
 */

/** GET one cat21-ord JSON path. */
export interface Cat21OrdReader {
  /**
   * GET `path` (starting with `/`) as JSON: the parsed body for a 2xx, `null`
   * for a 404, a throw for any other status.
   */
  getJson(path: string): Promise<unknown>;
}

/**
 * A {@link Cat21OrdReader} over `fetch`. `baseUrl` is the caller's cat21-ord
 * (a trailing slash is tolerated); `fetch` defaults to the global one.
 * cat21-ord answers only a JSON `Accept` (`--disable-html` sends 406
 * otherwise), so every request asks for JSON.
 */
export function cat21OrdFetchReader(
  baseUrl: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Cat21OrdReader {
  const base = baseUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetch ?? fetch;
  return {
    async getJson(path: string): Promise<unknown> {
      const url = `${base}${path}`;
      const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: opts.signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`cat21-ord ${url} answered ${response.status}`);
      return response.json();
    },
  };
}

/** An inscription id as cat21-ord spells it: 64 hex txid, `i`, index. */
const INSCRIPTION_ID = /^[0-9a-f]{64}i\d+$/;

/**
 * The cat numbers on `txid:vout`, ascending and without duplicates.
 *
 * - `null`: cat21-ord answers 404 for the output (unknown or spent).
 * - `[]`: the output exists and carries no cat.
 * - throws: cat21-ord answers another error, `cats` is missing or holds
 *   something other than an inscription id, an id does not resolve, or its
 *   `number` is not a cat number.
 */
export async function getCatsAtOutput(reader: Cat21OrdReader, txid: string, vout: number): Promise<number[] | null> {
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error(`getCatsAtOutput: ${txid} is not a txid`);
  if (!Number.isSafeInteger(vout) || vout < 0) throw new Error(`getCatsAtOutput: ${vout} is not an output index`);
  const outpoint = `${txid.toLowerCase()}:${vout}`;

  const output = await reader.getJson(`/output/${outpoint}`);
  if (output === null) return null;
  const cats = (output as { cats?: unknown }).cats;
  if (!Array.isArray(cats)) throw new Error(`getCatsAtOutput: cat21-ord /output/${outpoint} has no cats list`);

  const numbers = await Promise.all(cats.map(async (id: unknown) => {
    if (typeof id !== 'string' || !INSCRIPTION_ID.test(id)) {
      throw new Error(`getCatsAtOutput: /output/${outpoint} lists ${JSON.stringify(id)}, not an inscription id`);
    }
    const inscription = await reader.getJson(`/inscription/${id}`);
    if (inscription === null) throw new Error(`getCatsAtOutput: /output/${outpoint} lists ${id}, which /inscription does not know`);
    const number = (inscription as { number?: unknown }).number;
    if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
      throw new Error(`getCatsAtOutput: /inscription/${id} has number ${JSON.stringify(number)}, not a cat number`);
    }
    return number;
  }));
  return [...new Set(numbers)].sort((a, b) => a - b);
}
