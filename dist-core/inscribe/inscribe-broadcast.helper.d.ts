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
/**
 * Default fan-out endpoints. Both speak BIP-331 `submitpackage`
 * over an Esplora-compatible `/txs/package` POST.
 *
 * Order is by preference (ours first), but the helper POSTs to
 * ALL endpoints concurrently — the order only matters for the
 * `reason` field in the response if multiple endpoints succeed
 * simultaneously.
 */
export declare const DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS: ReadonlyArray<string>;
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
     * True iff AT LEAST one endpoint reported HTTP 2xx. Per the Phase-1
     * design ("our job is done when at least one endpoint accepts"),
     * this is the only field consumers need to branch on.
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
export declare function broadcastInscribePackage(input: InscribePackageBroadcastInput, options?: InscribePackageBroadcastOptions): Promise<InscribePackageBroadcastResult>;
//# sourceMappingURL=inscribe-broadcast.helper.d.ts.map