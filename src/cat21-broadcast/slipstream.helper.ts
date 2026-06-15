/**
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
export const SLIPSTREAM_DEFAULT_BASE_URL = 'https://slipstream.mara.com';

/** Path component appended to the base URL for the submit endpoint. */
export const SLIPSTREAM_SUBMIT_PATH = '/api/transactions';

/** JSON body field name carrying the raw tx hex. */
export const SLIPSTREAM_BODY_TX_FIELD = 'tx_hex';

/** Shape of the Slipstream submit success response. */
export interface SlipstreamSubmitResponse {
  txid: string;
}

/** Shape of Slipstream's error envelope. */
interface SlipstreamErrorBody {
  status: 'error';
  message: string;
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
export async function submitToSlipstream(
  rawTxHex: string,
  options: SubmitToSlipstreamOptions = {}
): Promise<SlipstreamSubmitResponse> {
  if (!rawTxHex || typeof rawTxHex !== 'string') {
    throw new Error('rawTxHex must be a non-empty string');
  }

  const url = `${options.baseUrl ?? SLIPSTREAM_DEFAULT_BASE_URL}${SLIPSTREAM_SUBMIT_PATH}`;
  const fetchFn = options.fetchImpl ?? fetch;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.bearerToken) {
    headers.Authorization = `Bearer ${options.bearerToken}`;
  }

  const res = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ [SLIPSTREAM_BODY_TX_FIELD]: rawTxHex }),
    signal: options.signal,
  });

  if (!res.ok) {
    const text = await safeReadText(res);
    // Slipstream's documented error envelope is `{status:"error",message:string}`.
    // We surface the message if present, fall back to raw body.
    let detail = text || '(empty body)';
    try {
      const parsed = JSON.parse(text) as Partial<SlipstreamErrorBody>;
      if (parsed && typeof parsed.message === 'string') detail = parsed.message;
    } catch {
      // not JSON — keep raw text
    }
    throw new Error(`Slipstream rejected submission with HTTP ${res.status}: ${detail}`);
  }

  const body: unknown = await res.json();
  if (!isSlipstreamSubmitResponse(body)) {
    throw new Error('Slipstream response body missing required "txid" string field');
  }
  return body;
}

function isSlipstreamSubmitResponse(body: unknown): body is SlipstreamSubmitResponse {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { txid?: unknown }).txid === 'string' &&
    (body as { txid: string }).txid.length > 0
  );
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
