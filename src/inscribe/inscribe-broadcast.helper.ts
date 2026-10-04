/**
 * Inscribe broadcast helper.
 *
 * The inscribe orchestrators do not use this: they go through
 * `broadcastCommitAndReveal` (`inscribe-package-broadcast.ts`), which
 * validates the pair with `testmempoolaccept` first and recovers a
 * commit that lands alone. This is the bare submission step, kept for
 * callers that already hold a signed pair.
 *
 *  - `submitpackage` is NOT atomic. Core keeps every transaction that
 *    passes on its own ("If any transaction passes, it will be accepted
 *    to mempool", `bitcoin-cli help submitpackage`, v30.2), and electrs
 *    returns that result as HTTP 200 with `package_msg: "transaction
 *    failed"`. So acceptance here means `package_msg === "success"`,
 *    never the HTTP status. ordpool-electrs serves the route at
 *    `POST /txs/package` (`rest.rs:1544`).
 *  - The package goes to every endpoint in parallel (by default our
 *    electrs at `api.ordpool.space` and blockstream's). It counts as
 *    sent when one endpoint reports success; the others are kept for
 *    diagnostics.
 *  - No retry here. If no endpoint reports success, recovering a commit
 *    that may have landed alone is the caller's job, with the ephemeral
 *    key and the reveal bytes; `broadcastCommitAndReveal` does exactly
 *    that.
 *
 * No Slipstream branch yet. Standard-weight inscriptions
 * (≤350 KB body → reveal stays under MAX_STANDARD_TX_WEIGHT)
 * land via public mempool; oversized payloads are a Phase-3
 * concern.
 */

import { STANDARD_TX_WEIGHT_LIMIT } from '../cat21-broadcast/broadcast.helper.js';

/**
 * Default fan-out endpoints. Both speak BIP-331 `submitpackage`
 * over an Esplora-compatible `/txs/package` POST.
 *
 * Order is by preference (ours first), but the helper POSTs to
 * ALL endpoints concurrently — the order only matters for the
 * `reason` field in the response if multiple endpoints succeed
 * simultaneously.
 */
export const DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS: ReadonlyArray<string> = [
  'https://api.ordpool.space/api',
  'https://blockstream.info/api',
];

/** Single per-endpoint outcome. */
export interface InscribePackageEndpointResult {
  endpoint: string;
  ok: boolean;
  /** HTTP status code when the endpoint responded; -1 when the request itself failed. */
  status: number;
  /** Body text on accept (typically the commit txid) or error text on reject. */
  body: string;
}

export interface InscribePackageBroadcastInput {
  /** Commit tx hex (signed + finalized by the user's wallet). */
  commitHex: string;
  /** Reveal tx hex (already finalized by the orchestrator with the ephemeral key). */
  revealHex: string;
  /**
   * Pre-computed weight of the (commit + reveal) pair. Used only to
   * surface a structured error when the package is too heavy for
   * standard relay; we DON'T silently route to Slipstream from here.
   */
  packageWeight?: number;
}

export interface InscribePackageBroadcastOptions {
  /** Override the default endpoints. The helper POSTs to all in parallel. */
  endpoints?: ReadonlyArray<string>;
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. Default: 15s. */
  perEndpointTimeoutMs?: number;
  /** Allows tests + node-only environments to inject a fetch impl. */
  fetchImpl?: typeof fetch;
}

export interface InscribePackageBroadcastResult {
  /**
   * True iff at least one endpoint reported `package_msg: "success"`,
   * i.e. both transactions are in its mempool.
   */
  ok: boolean;
  /**
   * Per-endpoint outcomes. Useful for surfacing degraded states
   * ("the package landed on ordpool but blockstream rejected with
   * `txn-mempool-conflict`") without changing the consumer's
   * primary success path.
   */
  endpointResults: ReadonlyArray<InscribePackageEndpointResult>;
}

/**
 * POST the (commit, reveal) package to every configured endpoint in
 * parallel and resolve when each endpoint has either responded or
 * timed out.
 *
 * Never throws. A network failure on every endpoint manifests as
 * `{ ok: false, endpointResults: [...] }` so the caller's error path
 * stays inside a discriminated union.
 *
 * # Endpoint contract
 *
 *  - `POST <endpoint>/txs/package`
 *  - Body: JSON array of hex strings, parent first then child:
 *    `[commitHex, revealHex]`. Matches ordpool-electrs's parser at
 *    `rest.rs:1544` and the BIP-331 `submitpackage` shape Core uses.
 *  - Accepted only when the 2xx body is Core's `submitpackage` object
 *    with `package_msg: "success"`. A 2xx carrying any other
 *    `package_msg` means at most part of the package went in.
 *  - Non-2xx → rejected. Body is the error text for diagnostics.
 *
 * The function never aborts the slow endpoint when the fast one
 * succeeds. We want diagnostic data from both. The price is a
 * brief wait for the slow endpoint or its timeout; in practice
 * sub-second.
 */
export async function broadcastInscribePackage(
  input: InscribePackageBroadcastInput,
  options: InscribePackageBroadcastOptions = {},
): Promise<InscribePackageBroadcastResult> {
  if (
    input.packageWeight !== undefined &&
    input.packageWeight > STANDARD_TX_WEIGHT_LIMIT
  ) {
    // Phase 1 fails closed on oversized packages; Phase 3 lifts via
    // Slipstream. We surface the result as a synthetic "all-endpoints-
    // rejected" outcome so consumers don't need a second error path.
    return {
      ok: false,
      endpointResults: [{
        endpoint: '(pre-flight)',
        ok: false,
        status: -1,
        body:
          `Package weight ${input.packageWeight} exceeds standard ceiling ` +
          `${STANDARD_TX_WEIGHT_LIMIT}; Phase-1 inscribe rejects to avoid ` +
          `wasting commit fees on a non-standard reveal`,
      }],
    };
  }

  const endpoints = options.endpoints ?? DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.perEndpointTimeoutMs ?? 15_000;
  const body = JSON.stringify([input.commitHex, input.revealHex]);

  const perEndpoint = endpoints.map(endpoint =>
    postPackage(endpoint, body, fetchImpl, timeoutMs, options.signal),
  );
  const endpointResults = await Promise.all(perEndpoint);

  return {
    ok: endpointResults.some(r => r.ok),
    endpointResults,
  };
}

async function postPackage(
  endpoint: string,
  body: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
): Promise<InscribePackageEndpointResult> {
  const url = `${endpoint.replace(/\/+$/, '')}/txs/package`;
  const controller = new AbortController();
  // If the caller handed us an already-aborted signal, propagate
  // immediately. `addEventListener('abort', …)` does NOT fire for
  // already-past events, so without this check the fetch would run
  // to completion (or timeout) despite the caller having cancelled.
  if (outerSignal?.aborted) controller.abort();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onOuterAbort);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      endpoint: url,
      ok: response.ok && packageSucceeded(text),
      status: response.status,
      body: text,
    };
  } catch (err) {
    return {
      endpoint: url,
      ok: false,
      status: -1,
      body: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeoutId);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Whether a `/txs/package` body says both transactions are in the mempool. */
function packageSucceeded(body: string): boolean {
  try {
    return (JSON.parse(body) as { package_msg?: unknown }).package_msg === 'success';
  } catch {
    return false;
  }
}
