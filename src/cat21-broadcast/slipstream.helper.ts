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
 */
export const SLIPSTREAM_DEFAULT_BASE_URL = 'https://slipstream.mara.com';

/** Shape of the Slipstream `/api/v1/transactions` success response. */
export interface SlipstreamSubmitResponse {
  txid: string;
}

export interface SubmitToSlipstreamOptions {
  /** Override base URL, e.g. for a self-hosted miner relay. */
  baseUrl?: string;
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

  const url = `${options.baseUrl ?? SLIPSTREAM_DEFAULT_BASE_URL}/api/v1/transactions`;
  const fetchFn = options.fetchImpl ?? fetch;

  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw_transaction: rawTxHex }),
    signal: options.signal,
  });

  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(
      `Slipstream rejected submission with HTTP ${res.status}: ${text || '(empty body)'}`
    );
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
