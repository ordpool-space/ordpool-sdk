import { injectable } from 'inversify';

import { SlipstreamApiClient } from '../infrastructure/api/slipstream/slipstream-api.client';

/**
 * Standard relay weight ceiling. Witness transactions above this size are
 * non-standard and the public mempool will reject them. The number matches
 * Bitcoin Core's `MAX_STANDARD_TX_WEIGHT` default (400 kvB = 400_000 weight
 * units). When a CAT-21 mint somehow exceeds this we route to Slipstream
 * because it bypasses standardness.
 */
export const STANDARD_TX_WEIGHT_LIMIT = 400_000;

export type Cat21BroadcastChannel = 'mempool' | 'slipstream';

export interface Cat21BroadcastDecision {
  channel: Cat21BroadcastChannel;
  reason: string;
}

export interface Cat21BroadcastOptions {
  /**
   * Force a specific channel. When omitted the dispatcher decides based on tx
   * properties (weight, user preference). Per ADR-6 the default is mempool;
   * Slipstream is the opt-in fallback for oversize / non-standard cases.
   */
  forceChannel?: Cat21BroadcastChannel;
  signal?: AbortSignal;
}

export interface Cat21BroadcastInput {
  hex: string;
  /** Transaction weight in weight units. From `tx.weight` on `@scure/btc-signer`. */
  weight: number;
}

export interface Cat21BroadcastResult {
  txid: string;
  channel: Cat21BroadcastChannel;
}

/**
 * Phase 3.3 broadcast surface for CAT-21 mints. The dispatcher picks between
 * the public mempool and Slipstream based on tx weight (per ADR-6). The
 * actual public-mempool POST lives in the legacy bitcoin-client (in @leather.io/query);
 * this service is intentionally not coupled to that layer so it can run in
 * non-extension contexts (MCP server, future CLI).
 *
 * For Slipstream we own the client; for mempool the caller passes the
 * mempool-broadcast callback in. This keeps the service single-responsibility
 * — it decides *which* channel and surfaces a unified result — without
 * dragging in axios+esplora wiring.
 */
@injectable()
export class Cat21BroadcastService {
  constructor(private readonly slipstreamApiClient: SlipstreamApiClient) {}

  public decideChannel(
    input: Cat21BroadcastInput,
    options: Cat21BroadcastOptions = {}
  ): Cat21BroadcastDecision {
    if (options.forceChannel) {
      return {
        channel: options.forceChannel,
        reason: `forced by caller (forceChannel=${options.forceChannel})`,
      };
    }
    if (input.weight > STANDARD_TX_WEIGHT_LIMIT) {
      return {
        channel: 'slipstream',
        reason: `weight ${input.weight} exceeds standard ceiling ${STANDARD_TX_WEIGHT_LIMIT}`,
      };
    }
    return { channel: 'mempool', reason: 'standard-weight mint, public mempool is fine' };
  }

  public async broadcast(
    input: Cat21BroadcastInput,
    broadcastViaMempool: (hex: string) => Promise<string>,
    options: Cat21BroadcastOptions = {}
  ): Promise<Cat21BroadcastResult> {
    const decision = this.decideChannel(input, options);
    if (decision.channel === 'slipstream') {
      const res = await this.slipstreamApiClient.submitTransaction(input.hex, {
        signal: options.signal,
      });
      return { txid: res.txid, channel: 'slipstream' };
    }
    const txid = await broadcastViaMempool(input.hex);
    return { txid, channel: 'mempool' };
  }
}
