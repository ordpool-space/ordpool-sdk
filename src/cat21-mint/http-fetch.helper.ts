import { Observable, from } from 'rxjs';

/**
 * Native-`fetch` HTTP primitives for the SDK's stateful clients
 * (`Cat21Service`, `Cat21ApiService`, `UtxoContentScanner`). They load and run
 * anywhere the rest of the SDK does (browser, plain Node, a regtest jest
 * harness), matching the workspace "use fetch, not axios" rule.
 *
 * Each rejects on a non-2xx status, carrying the response BODY as the error
 * message (so an electrs/mempool broadcast rejection keeps its reason, e.g.
 * "txn-mempool-conflict") — the callers' `catchError` chains read `err.message`
 * and surface it unchanged. The `Observable` form wraps the async form so the
 * clients' RxJS pipelines consume it directly.
 */
async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `${init?.method ?? 'GET'} ${url} failed: HTTP ${res.status}`);
  }
  return res;
}

/** `GET <url>` → parsed JSON, Promise form. Sends `Accept: application/json`
 * (the ord hosts gate HTML behind it). The framework-agnostic form used by
 * plain-async consumers (the `cat21-api.fetch` twin, bots, CLIs). */
export function fetchJsonAsync<T>(url: string): Promise<T> {
  return fetchOk(url, { headers: { Accept: 'application/json' } }).then((r) => r.json() as Promise<T>);
}

/** `GET <url>` → parsed JSON, Observable form. Thin RxJS wrapper over
 * `fetchJsonAsync` for the stateful clients' `.pipe(catchError)` chains. */
export function fetchJson<T>(url: string): Observable<T> {
  return from(fetchJsonAsync<T>(url));
}

/** `GET <url>` → raw text (e.g. an esplora `/tx/:id/hex` response). */
export function fetchText(url: string): Observable<string> {
  return from(fetchOk(url).then((r) => r.text()));
}

/** `POST <url>` with a raw string body → text response (e.g. esplora `/tx`
 * returning the broadcast txid). */
export function postText(url: string, body: string): Observable<string> {
  return from(fetchOk(url, { method: 'POST', body }).then((r) => r.text()));
}
