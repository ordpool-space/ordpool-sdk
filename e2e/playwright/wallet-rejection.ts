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

/**
 * The `code` a probe's own timer resolves with when the wallet never answered.
 * Pass it into the page (`evaluate(fn, WALLET_PROBE_TIMEOUT_CODE)`): an
 * evaluated function cannot close over a Node-side import.
 */
export const WALLET_PROBE_TIMEOUT_CODE = 'timeout';

/** The probe's result: whatever the wallet resolved or rejected with. */
export interface WalletProbeOutcome {
  ok?: unknown;
  code?: unknown;
  err?: unknown;
  accs?: unknown;
}

export interface WalletRejectionShape {
  /** The wallet itself rejected. False for our own timeout sentinel. */
  refused: boolean;
  /** The wallet never answered and the probe's own timer resolved instead. */
  timedOut: boolean;
  /** A numeric wallet code (EIP-1193 / JSON-RPC). */
  carriesCode: boolean;
  /** A non-empty message from the wallet. False for our own timeout sentinel. */
  carriesMessage: boolean;
  handedOutAccounts: boolean;
}

export function describeWalletRejection(outcome: WalletProbeOutcome): WalletRejectionShape {
  const timedOut = outcome.ok === false && outcome.code === WALLET_PROBE_TIMEOUT_CODE;
  return {
    refused: outcome.ok === false && !timedOut,
    timedOut,
    carriesCode: typeof outcome.code === 'number',
    carriesMessage: !timedOut && typeof outcome.err === 'string' && outcome.err.length > 0,
    handedOutAccounts: 'accs' in outcome,
  };
}

/** The shape a genuine refusal has, whatever the wallet called it. */
export const REFUSED_WITH_DETAIL: WalletRejectionShape = {
  refused: true,
  timedOut: false,
  carriesCode: true,
  carriesMessage: true,
  handedOutAccounts: false,
};
