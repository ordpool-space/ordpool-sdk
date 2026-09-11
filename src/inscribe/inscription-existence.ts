import { encodeInscriptionId } from './inscription-envelope';

/**
 * Whether an inscription id exists, per an ord server. `unknown` is a
 * failed lookup (network error, timeout, a server error), never taken as
 * `missing`.
 */
export type InscriptionExistence = 'exists' | 'missing' | 'invalid' | 'unknown';

export interface CheckInscriptionsExistOptions {
  /** Base URL of an ord server with the JSON API, e.g. `https://ord.ordpool.space`. */
  ordBaseUrl: string;
  /** Per-request timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /** Requests in flight at once. Default 4. */
  concurrency?: number;
  /** The fetch to use. Default the global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * Check inscription ids against an ord server, one `GET /inscription/<id>`
 * each (with `Accept: application/json`): 200 means it exists, 404 means it
 * does not. ord refuses to inscribe a gallery or delegate that points at an
 * inscription its index does not have ("referenced inscriptions do not
 * exist"), so a UI checks gallery items and delegates with this before it
 * builds anything.
 *
 * A malformed id is `invalid` without a request. Duplicate ids are looked up
 * once. The result has an entry for every distinct id passed in.
 */
export async function checkInscriptionsExist(
  ids: ReadonlyArray<string>,
  options: CheckInscriptionsExistOptions,
): Promise<Map<string, InscriptionExistence>> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const base = options.ordBaseUrl.replace(/\/+$/, '');

  const result = new Map<string, InscriptionExistence>();
  const toFetch: string[] = [];
  for (const id of new Set(ids)) {
    try {
      encodeInscriptionId(id);
      toFetch.push(id);
    } catch {
      result.set(id, 'invalid');
    }
  }

  const lookup = async (id: string): Promise<InscriptionExistence> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${base}/inscription/${id}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (res.status === 200) return 'exists';
      if (res.status === 404) return 'missing';
      return 'unknown';
    } catch {
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < toFetch.length) {
      const id = toFetch[next++];
      result.set(id, await lookup(id));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, toFetch.length) }, worker));
  return result;
}
