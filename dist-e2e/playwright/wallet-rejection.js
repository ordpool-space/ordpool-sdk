"use strict";
/**
 * Describe a wallet's refusal in terms we own.
 *
 * A spec that pins WHICH error a third-party wallet returned is pinning the
 * wallet's taxonomy: it changes between releases, and one underlying state
 * routinely surfaces as several different errors. Wizz's fixture-absent P2TR
 * state has produced `-32603 "Connection error"` and
 * `4001 "User rejected the request."`, both meaning the same thing for the
 * question being asked.
 *
 * What a spec can honestly pin is the SHAPE: the wallet refused, it said so
 * with a code and a message, and it handed out no accounts. That fails when
 * the wallet resolves empty, returns undefined, hangs, or hands out an account
 * it should not have, and it is indifferent to the wording.
 *
 * A hang is not a refusal. A probe that races the wallet against its own timer
 * resolves with `code: WALLET_PROBE_TIMEOUT_CODE` when the timer wins; that
 * outcome reads as `timedOut: true, refused: false`, so it never matches
 * `REFUSED_WITH_DETAIL`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.REFUSED_WITH_DETAIL = exports.WALLET_PROBE_TIMEOUT_CODE = void 0;
exports.describeWalletRejection = describeWalletRejection;
/**
 * The `code` a probe's own timer resolves with when the wallet never answered.
 * Pass it into the page (`evaluate(fn, WALLET_PROBE_TIMEOUT_CODE)`): an
 * evaluated function cannot close over a Node-side import.
 */
exports.WALLET_PROBE_TIMEOUT_CODE = 'timeout';
function describeWalletRejection(outcome) {
    const timedOut = outcome.ok === false && outcome.code === exports.WALLET_PROBE_TIMEOUT_CODE;
    return {
        refused: outcome.ok === false && !timedOut,
        timedOut,
        carriesCode: typeof outcome.code === 'number',
        carriesMessage: !timedOut && typeof outcome.err === 'string' && outcome.err.length > 0,
        handedOutAccounts: 'accs' in outcome,
    };
}
/** The shape a genuine refusal has, whatever the wallet called it. */
exports.REFUSED_WITH_DETAIL = {
    refused: true,
    timedOut: false,
    carriesCode: true,
    carriesMessage: true,
    handedOutAccounts: false,
};
//# sourceMappingURL=wallet-rejection.js.map