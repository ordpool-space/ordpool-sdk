"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STANDARD_TX_WEIGHT_LIMIT = void 0;
exports.decideBroadcastChannel = decideBroadcastChannel;
exports.broadcastCat21 = broadcastCat21;
const slipstream_helper_1 = require("./slipstream.helper");
/**
 * Standard-relay weight ceiling — matches Bitcoin Core's
 * `MAX_STANDARD_TX_WEIGHT` (400 000 WU = 100 kvB). Above this the
 * public mempool rejects as non-standard and the dispatcher routes
 * to Slipstream (which bypasses standardness).
 *
 * Plain CAT-21 mints (~150 vB) never hit this. Slipstream is the
 * explicit fallback for oversize cases (large witness payload,
 * coin-consolidation alongside a mint, etc.).
 */
exports.STANDARD_TX_WEIGHT_LIMIT = 400_000;
/**
 * # DORMANT — currently unused by any SDK consumer.
 *
 * Zero callers anywhere in the SDK or in cat21.space / ordpool. Every
 * cat-touching tx we ship (mint, transfer, buy-offer, accept-offer) is
 * ~150–250 vB and standard, so the dispatcher's only non-mempool branch
 * — `weight > STANDARD_TX_WEIGHT_LIMIT` → Slipstream — never fires.
 * `forceChannel: 'slipstream'` likewise has no caller. Slipstream itself
 * is DORMANT (see `slipstream.helper.ts`).
 *
 * Kept (not deleted) because the dispatcher is the natural shape for the
 * day a use case surfaces (large witness bundled with a cat, future
 * protocol experiments). Reviving this is cheaper than rebuilding it.
 *
 * **Before re-enabling**: re-verify the Slipstream contract per
 * `slipstream.helper.ts`, and confirm the mempool callback the consumer
 * supplies still resolves the right way (electrs POST `/tx`).
 *
 * Decision-only entry point — deterministic given the input + options,
 * no side effects.
 */
function decideBroadcastChannel(input, options = {}) {
    if (options.forceChannel) {
        return {
            channel: options.forceChannel,
            reason: `forced by caller (forceChannel=${options.forceChannel})`,
        };
    }
    if (input.weight > exports.STANDARD_TX_WEIGHT_LIMIT) {
        return {
            channel: 'slipstream',
            reason: `weight ${input.weight} exceeds standard ceiling ${exports.STANDARD_TX_WEIGHT_LIMIT}`,
        };
    }
    return {
        channel: 'mempool',
        reason: 'standard-weight tx, public mempool is sufficient',
    };
}
/**
 * # DORMANT — currently unused by any SDK consumer.
 *
 * The thin wrapper over `decideBroadcastChannel` + the mempool/Slipstream
 * branches. Every shipping cat-flow calls its broadcast callback
 * (electrs `POST /tx` via the ordpool backend) directly. See the dormancy
 * note on `decideBroadcastChannel`.
 *
 * The `broadcastViaMempool` callback is supplied by the consumer so the
 * SDK stays decoupled from any specific Esplora endpoint. The endpoint
 * is always **our own** electrs / ordpool backend — never mempool.space
 * (their API rejects our host by ban, and they're a competitor anyway;
 * see the workspace `CLAUDE.md` HARD RULE "Never call mempool.space from
 * shipping code").
 *
 * Failure mode: never silently retries. If Slipstream rejects, the caller
 * decides whether to fall back to the mempool callback. Auto-retry across
 * channels risks double-broadcast and is the caller's policy decision.
 */
async function broadcastCat21(input, broadcastViaMempool, options = {}) {
    const decision = decideBroadcastChannel(input, options);
    if (decision.channel === 'slipstream') {
        const res = await (0, slipstream_helper_1.submitToSlipstream)(input.hex, {
            baseUrl: options.slipstreamBaseUrl,
            signal: options.signal,
            fetchImpl: options.fetchImpl,
        });
        return { txid: res.txid, channel: 'slipstream' };
    }
    const txid = await broadcastViaMempool(input.hex);
    return { txid, channel: 'mempool' };
}
//# sourceMappingURL=broadcast.helper.js.map