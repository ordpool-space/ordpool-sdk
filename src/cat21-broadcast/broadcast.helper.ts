import { submitToSlipstream } from './slipstream.helper';

/**
 * Standard relay weight ceiling. Witness transactions above this weight are
 * non-standard and the public mempool rejects them. The constant matches
 * Bitcoin Core's `MAX_STANDARD_TX_WEIGHT` default (400_000 weight units =
 * 100 kvB). When a CAT-21 tx exceeds this, the dispatcher routes to
 * Slipstream because Slipstream bypasses standardness.
 *
 * For plain CAT-21 mints (~150 vB) this ceiling is never reached and the
 * dispatcher always picks the public mempool. Slipstream is the explicit
 * opt-in fallback for unusual cases (oversize witness data attached to a
 * mint, multi-input coin consolidations alongside a mint, etc.).
 */
export const STANDARD_TX_WEIGHT_LIMIT = 400_000;

/**
 * Broadcast channel. `'slipstream'` is currently DORMANT — see
 * `slipstream.helper.ts`. No SDK consumer routes there today (every
 * CAT-21 flow we ship is ~150 vB and standard); the branch is kept
 * for future oversize-tx use cases.
 */
export type Cat21BroadcastChannel = 'mempool' | 'slipstream';

export interface Cat21BroadcastDecision {
  channel: Cat21BroadcastChannel;
  reason: string;
}

export interface Cat21BroadcastInput {
  /** Raw transaction hex (signed + finalized). */
  hex: string;
  /** Tx weight in weight units. From `tx.weight` on `@scure/btc-signer`. */
  weight: number;
}

export interface Cat21BroadcastOptions {
  /**
   * Force a specific channel regardless of weight. When omitted the
   * dispatcher uses `decideBroadcastChannel`.
   */
  forceChannel?: Cat21BroadcastChannel;
  signal?: AbortSignal;
  /** Slipstream base URL override. */
  slipstreamBaseUrl?: string;
  /** Allows tests + node-only environments to inject a fetch impl. */
  fetchImpl?: typeof fetch;
}

export interface Cat21BroadcastResult {
  txid: string;
  channel: Cat21BroadcastChannel;
}

/**
 * Decision-only entry point. Useful for callers (cat21.space UI) that want
 * to show "your tx will go to X" before the user confirms the broadcast.
 *
 * The decision is deterministic given the input + options; it has no side
 * effects.
 */
export function decideBroadcastChannel(
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
  return {
    channel: 'mempool',
    reason: 'standard-weight tx, public mempool is sufficient',
  };
}

/**
 * Broadcasts a CAT-21 tx through the appropriate channel and returns the
 * accepted txid.
 *
 * The mempool path is the caller's job — pass `broadcastViaMempool` as the
 * second argument. This keeps the SDK decoupled from the specific mempool
 * API any one consumer uses (mempool.space vs blockstream vs self-hosted
 * electrs); we just call the callback when the dispatcher picks mempool.
 *
 * Slipstream is owned by the SDK (`submitToSlipstream`) because every
 * caller would otherwise duplicate the same fetch wrapper.
 *
 * Failure mode: never silently retries. If Slipstream rejects, the caller
 * decides whether to fall back to the mempool callback (which may itself
 * reject for the same standardness reason). Auto-retry across channels
 * risks double-broadcast and is the caller's policy decision.
 */
export async function broadcastCat21(
  input: Cat21BroadcastInput,
  broadcastViaMempool: (hex: string) => Promise<string>,
  options: Cat21BroadcastOptions = {}
): Promise<Cat21BroadcastResult> {
  const decision = decideBroadcastChannel(input, options);

  if (decision.channel === 'slipstream') {
    const res = await submitToSlipstream(input.hex, {
      baseUrl: options.slipstreamBaseUrl,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });
    return { txid: res.txid, channel: 'slipstream' };
  }

  const txid = await broadcastViaMempool(input.hex);
  return { txid, channel: 'mempool' };
}
