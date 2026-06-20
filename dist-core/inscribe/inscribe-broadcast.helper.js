"use strict";
/**
 * Inscribe broadcast helper.
 *
 * Phase-1 strategy (per the locked-in design decisions in
 * `OSS-INSCRIBERS.md`):
 *
 *  - The inscribe pipeline produces a (commit, reveal) tx pair. The
 *    two MUST land atomically: a confirmed commit without a known
 *    reveal stalls the wallet's recovery flow; a reveal that
 *    references an un-broadcast commit is rejected with
 *    `missing-inputs`.
 *  - Bitcoin Core v28+ exposes `submitpackage` (BIP-331) for atomic
 *    1-parent-1-child submission. ordpool-electrs already speaks
 *    `POST /txs/package` (`rest.rs:1544`); we POST the pair there.
 *  - We do NOT trust a single endpoint. Phase 1 fans out the package
 *    to BOTH our own electrs (`ord.ordpool.space` / `api.ordpool.space`)
 *    and blockstream's `/txs/package` in PARALLEL. The first 2xx
 *    wins; the second response is logged but does not influence the
 *    return. "Our job is done" the moment one endpoint reports
 *    acceptance.
 *  - Per `OSS-INSCRIBERS.md` Q1+Q2: no journal, no retry. The
 *    ephemeral key is zeroed in `createInscribeTransactions` BEFORE
 *    this helper runs; if both endpoints reject the package, the
 *    inscription is unrecoverable from this process and the caller
 *    surfaces a final error to the user.
 *  - `testmempoolaccept` is intentionally NOT pre-flighted. The
 *    real submission IS the test; pre-flighting doubles request
 *    volume for no benefit (acceptance has the same edge cases
 *    either way, and a successful pre-flight does not guarantee
 *    a successful broadcast moments later when mempool state
 *    changes).
 *
 * No Slipstream branch yet. Standard-weight inscriptions
 * (≤350 KB body → reveal stays under MAX_STANDARD_TX_WEIGHT)
 * land via public mempool; oversized payloads are a Phase-3
 * concern.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS = void 0;
exports.broadcastInscribePackage = broadcastInscribePackage;
const broadcast_helper_1 = require("../cat21-broadcast/broadcast.helper");
/**
 * Default fan-out endpoints. Both speak BIP-331 `submitpackage`
 * over an Esplora-compatible `/txs/package` POST.
 *
 * Order is by preference (ours first), but the helper POSTs to
 * ALL endpoints concurrently — the order only matters for the
 * `reason` field in the response if multiple endpoints succeed
 * simultaneously.
 */
exports.DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS = [
    'https://api.ordpool.space/api',
    'https://blockstream.info/api',
];
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
 *  - 2xx response → accepted. Body is implementation-specific
 *    (electrs returns the parent txid; Core's mempool returns a
 *    structured JSON object). We don't parse it — acceptance is
 *    the signal, body is for diagnostics.
 *  - Non-2xx → rejected. Body is the error text for diagnostics.
 *
 * The function never aborts the slow endpoint when the fast one
 * succeeds. We want diagnostic data from both. The price is a
 * brief wait for the slow endpoint or its timeout; in practice
 * sub-second.
 */
async function broadcastInscribePackage(input, options = {}) {
    if (input.packageWeight !== undefined &&
        input.packageWeight > broadcast_helper_1.STANDARD_TX_WEIGHT_LIMIT) {
        // Phase 1 fails closed on oversized packages; Phase 3 lifts via
        // Slipstream. We surface the result as a synthetic "all-endpoints-
        // rejected" outcome so consumers don't need a second error path.
        return {
            ok: false,
            endpointResults: [{
                    endpoint: '(pre-flight)',
                    ok: false,
                    status: -1,
                    body: `Package weight ${input.packageWeight} exceeds standard ceiling ` +
                        `${broadcast_helper_1.STANDARD_TX_WEIGHT_LIMIT}; Phase-1 inscribe rejects to avoid ` +
                        `wasting commit fees on a non-standard reveal`,
                }],
        };
    }
    const endpoints = options.endpoints ?? exports.DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS;
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.perEndpointTimeoutMs ?? 15_000;
    const body = JSON.stringify([input.commitHex, input.revealHex]);
    const perEndpoint = endpoints.map(endpoint => postPackage(endpoint, body, fetchImpl, timeoutMs, options.signal));
    const endpointResults = await Promise.all(perEndpoint);
    return {
        ok: endpointResults.some(r => r.ok),
        endpointResults,
    };
}
async function postPackage(endpoint, body, fetchImpl, timeoutMs, outerSignal) {
    const url = `${endpoint.replace(/\/+$/, '')}/txs/package`;
    const controller = new AbortController();
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
            ok: response.ok,
            status: response.status,
            body: text,
        };
    }
    catch (err) {
        return {
            endpoint: url,
            ok: false,
            status: -1,
            body: err instanceof Error ? err.message : String(err),
        };
    }
    finally {
        clearTimeout(timeoutId);
        outerSignal?.removeEventListener('abort', onOuterAbort);
    }
}
//# sourceMappingURL=inscribe-broadcast.helper.js.map