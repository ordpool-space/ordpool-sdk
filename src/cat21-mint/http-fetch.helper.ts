import { Observable, from } from 'rxjs';

/**
 * Native-fetch HTTP primitives for the SDK's Angular services (`Cat21Service`,
 * `Cat21ApiService`, `UtxoContentScanner`). The SDK uses `fetch`, never
 * Angular's `HttpClient` — so these services carry no `@angular/common/http`
 * dependency and load + run anywhere the rest of the SDK does (browser, plain
 * Node, a regtest jest harness), matching the workspace "use fetch, not axios"
 * rule.
 *
 * Each rejects on a non-2xx status, carrying the response BODY as the error
 * message (so an electrs/mempool broadcast rejection keeps its reason, e.g.
 * "txn-mempool-conflict") — the callers' existing `catchError` chains read
 * `err.message` and surface it unchanged.
 */
async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `${init?.method ?? 'GET'} ${url} failed: HTTP ${res.status}`);
  }
  return res;
}

/** `GET <url>` → parsed JSON. Sends `Accept: application/json` (the ord hosts
 * gate HTML behind it). */
export function fetchJson<T>(url: string): Observable<T> {
  return from(
    fetchOk(url, { headers: { Accept: 'application/json' } }).then((r) => r.json() as Promise<T>),
  );
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
