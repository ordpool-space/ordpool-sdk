/**
 * # DORMANT — currently unused by any SDK consumer.
 *
 * Plain CAT-21 mints / transfers / offers are ~150 vB and standard, so
 * `decideBroadcastChannel` never routes here unless the caller passes
 * `forceChannel: 'slipstream'` or a tx exceeds `MAX_STANDARD_TX_WEIGHT
 * = 400 000`. Neither happens in any flow shipping today.
 *
 * Kept (not deleted) because the dispatcher pattern + the verified
 * Marathon contract are non-trivial to re-derive — when a use case
 * surfaces (oversize witness data bundled with cats, atomicals-like
 * payloads, future protocol experiments), reviving this helper is
 * cheaper than rebuilding it.
 *
 * **Before re-enabling**, re-verify the Marathon API contract with
 * curl probes (see the "verified" block below — the contract drifted
 * once already, both URL path and body field were wrong in an earlier
 * iteration). Bump the verification date in the docstring.
 *
 * # Background
 *
 * Marathon Slipstream is a direct-to-miner submission API. Useful when the
 * public mempool would policy-reject a transaction (oversize witness,
 * non-standard scripts, datacarrier above local limits). For plain CAT-21
 * mints the public mempool path is sufficient; Slipstream is the explicit
 * fallback for oversize cases.
 *
 * The base URL is the published one. Users running their own miner relay
 * (rare) can pass an override. There is no testnet endpoint; Slipstream is
 * mainnet-only.
 *
 * # API contract — verified 2026-06-15
 *
 * Endpoint:        POST https://slipstream.mara.com/api/transactions
 * Body:            `{ "tx_hex": "<hex-encoded-raw-tx>" }`
 * Auth:            Client code required (`Authorization: Bearer <token>`,
 *                  per the frontend bundle). Without a client code the
 *                  endpoint accepts the call up through deserialisation
 *                  but rejects the actual broadcast. Contact
 *                  foundation@mara.com to provision.
 *
 * Source of truth: derived by reading the Slipstream operator UI bundle
 * at `https://slipstream.mara.com/assets/index-T1J5o0ND.js`, which
 * defines `sx = "https://slipstream.mara.com"`,
 * `Pn = \`${sx}/api/\``, `Sl = \`${Pn}transactions\`` and the submit
 * function `(e) => Te.post(Sl, e).data`. Verified by curl probe on
 * 2026-06-15 17:07-08 UTC:
 *
 *     curl -X POST https://slipstream.mara.com/api/transactions \
 *          -H 'Content-Type: application/json' -d '{}'
 *     → 400 {"status":"error","message":"Invalid JSON payload"}
 *
 *     curl -X POST https://slipstream.mara.com/api/transactions \
 *          -H 'Content-Type: application/json' -d '{"tx_hex":"0100"}'
 *     → 400 {"status":"error","message":"Failed to deserialize transaction"}
 *
 *     curl -X POST https://slipstream.mara.com/api/transactions \
 *          -H 'Content-Type: application/json' -d '{"raw_transaction":"0100"}'
 *     → 400 {"status":"error","message":"Invalid JSON payload"}  // wrong field
 *
 *     curl https://slipstream.mara.com/api/v1/transactions
 *     → 404 Cannot POST /api/v1/transactions                     // wrong path
 *
 * Error response envelope: `{ status: "error", message: string }`.
 * Success response: `{ txid: string }` (frontend reads `(await Te.post
 * (Sl, e)).data.txid`).
 */
export declare const SLIPSTREAM_DEFAULT_BASE_URL = "https://slipstream.mara.com";
/** Path component appended to the base URL for the submit endpoint. */
export declare const SLIPSTREAM_SUBMIT_PATH = "/api/transactions";
/** JSON body field name carrying the raw tx hex. */
export declare const SLIPSTREAM_BODY_TX_FIELD = "tx_hex";
/** Shape of the Slipstream submit success response. */
export interface SlipstreamSubmitResponse {
    txid: string;
}
export interface SubmitToSlipstreamOptions {
    /** Override base URL, e.g. for a self-hosted miner relay. */
    baseUrl?: string;
    /**
     * Bearer token issued by Marathon. Required for the broadcast to
     * actually fire — without it, the endpoint will accept the JSON +
     * deserialise the tx but the submission is rejected at the
     * authorisation gate. Contact foundation@mara.com to provision.
     */
    bearerToken?: string;
    signal?: AbortSignal;
    /**
     * `fetch` impl. Defaults to the global `fetch`. Allows tests + Node
     * environments without a configured global to inject a polyfill.
     */
    fetchImpl?: typeof fetch;
}
/**
 * Submit a single raw transaction (hex) to Slipstream. Returns the txid the
 * miner relay accepted, which is also the txid the network will see.
 *
 * Throws on non-2xx OR on a response body without a `txid` string. The
 * caller is expected to either fall back to standard mempool broadcast OR
 * surface the error — never to retry blindly, since Slipstream submissions
 * can be expensive and may double-broadcast if the caller is not careful.
 *
 * Uses `fetch + AbortController` (no axios per SDK convention).
 */
export declare function submitToSlipstream(rawTxHex: string, options?: SubmitToSlipstreamOptions): Promise<SlipstreamSubmitResponse>;
//# sourceMappingURL=slipstream.helper.d.ts.map