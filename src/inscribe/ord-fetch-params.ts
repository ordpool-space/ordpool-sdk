/** The ord-HTTP options the existence probe and the rare-sat picker both read. */
export interface OrdFetchOptions {
  ordBaseUrl: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  concurrency?: number;
}

/**
 * Resolve the shared ord-HTTP options to concrete values: the fetch impl
 * (defaulting to global `fetch`), the per-request timeout, a concurrency of at
 * least 1, and the base URL with trailing slashes stripped.
 */
export function resolveOrdFetchParams(options: OrdFetchOptions): {
  fetchFn: typeof fetch;
  timeoutMs: number;
  concurrency: number;
  base: string;
} {
  return {
    fetchFn: options.fetchFn ?? fetch,
    timeoutMs: options.timeoutMs ?? 10_000,
    concurrency: Math.max(1, options.concurrency ?? 4),
    base: options.ordBaseUrl.replace(/\/+$/, ''),
  };
}
