import axios from 'axios';
import { injectable } from 'inversify';
import { z } from 'zod';

/**
 * Marathon Slipstream is a direct-to-miner submission API. Useful when the
 * public mempool would policy-reject a transaction (oversize witness, non-
 * standard scripts, datacarrier above local limits). For CAT-21 mints the
 * plain mempool path is fine; Slipstream is the explicit-opt-in fallback per
 * ADR-6 ("stays as broadcast option, not as anti-snipe").
 *
 * The base URL is the published one; users can override via the constructor
 * if they're running their own miner relay. There is no testnet endpoint
 * (mainnet-only per ADR-7), so the client does not network-mode-switch.
 *
 * Per ADR-11, axios is the HTTP client.
 */
export const SLIPSTREAM_DEFAULT_BASE_URL = 'https://slipstream.mara.com';

export const slipstreamSubmitResponseSchema = z
  .object({
    txid: z.string(),
  })
  .passthrough();

export type SlipstreamSubmitResponse = z.infer<typeof slipstreamSubmitResponseSchema>;

export interface SlipstreamSubmitOptions {
  baseUrl?: string;
  signal?: AbortSignal;
}

@injectable()
export class SlipstreamApiClient {
  /**
   * Submit a single raw transaction to Slipstream. Returns the txid the
   * miner relay accepted, which is also the txid the network will see.
   *
   * Throws on non-2xx. Caller is expected to fall back to standard mempool
   * broadcast OR surface the error — never to retry blindly, since
   * Slipstream submissions can be expensive and may double-broadcast if the
   * caller is not careful.
   */
  public async submitTransaction(
    rawTxHex: string,
    { baseUrl, signal }: SlipstreamSubmitOptions = {}
  ): Promise<SlipstreamSubmitResponse> {
    const url = `${baseUrl ?? SLIPSTREAM_DEFAULT_BASE_URL}/api/v1/transactions`;
    const res = await axios.post<unknown>(
      url,
      { raw_transaction: rawTxHex },
      {
        signal,
        headers: { 'Content-Type': 'application/json' },
      }
    );
    return slipstreamSubmitResponseSchema.parse(res.data);
  }
}
