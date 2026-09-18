/**
 * Describe a wallet's refusal in terms we own.
 *
 * A spec that pins WHICH error a third-party wallet returned is pinning the
 * wallet's taxonomy: it changes between releases, and one underlying state
 * routinely surfaces as several different errors. Wizz's fixture-absent P2TR
 * state has produced `-32603 "Connection error"`, a silent 30s hang, and
 * `4001 "User rejected the request."`, all meaning the same thing for the
 * question being asked.
 *
 * What a spec can honestly pin is the SHAPE: the wallet refused, it said so
 * with a code and a message, and it handed out no accounts. That fails when
 * the wallet resolves empty, returns undefined, or hands out an account it
 * should not have, and it is indifferent to the wording.
 */

/** The probe's result: whatever the wallet resolved or rejected with. */
export interface WalletProbeOutcome {
  ok?: unknown;
  code?: unknown;
  err?: unknown;
  accs?: unknown;
}

export interface WalletRejectionShape {
  refused: boolean;
  /** A numeric wallet code (EIP-1193 / JSON-RPC), or our own `timeout` sentinel. */
  carriesCode: boolean;
  carriesMessage: boolean;
  handedOutAccounts: boolean;
}

export function describeWalletRejection(outcome: WalletProbeOutcome): WalletRejectionShape {
  return {
    refused: outcome.ok === false,
    carriesCode: typeof outcome.code === 'number' || outcome.code === 'timeout',
    carriesMessage: typeof outcome.err === 'string' && outcome.err.length > 0,
    handedOutAccounts: 'accs' in outcome,
  };
}

/** The shape a genuine refusal has, whatever the wallet called it. */
export const REFUSED_WITH_DETAIL: WalletRejectionShape = {
  refused: true,
  carriesCode: true,
  carriesMessage: true,
  handedOutAccounts: false,
};
