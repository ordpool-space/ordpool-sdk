/**
 * The error an execute path throws when the coin it would spend carries
 * assets (or unchecked content) and the caller's policy does not permit
 * spending one: `assetSpend: 'refuse'`.
 *
 * That is the agent path. A person sees the asset notice before they click
 * and decides; an agent acting alone has no owner opt-in for spending an asset
 * coin, so the flow stops before anything is signed and reports the same
 * facts the person would have been shown: the coin it would have spent, what
 * the scan named on it, and every candidate.
 *
 * Every field is plain JSON, so the error crosses an MCP bridge or a
 * `postMessage` boundary through `toJSON()` with nothing lost.
 */

import { AnnotatedFundingUtxo, FundingRecommendation } from './funding-safety.js';
import type { FundingBlockedCoin } from './funding-blocked-error.js';
import { toFundingCoinJson } from './funding-coin-json.js';

/**
 * Whether an execute path may spend a coin that carries assets.
 *
 * - `'after-notice'`: a person was shown the asset notice for this coin and
 *   chose to go on (the manual path, every web surface).
 * - `'refuse'`: nobody was shown it (an agent, a headless caller); spending
 *   such a coin throws `AssetSpendNotPermittedError` before signing.
 */
export type AssetSpendPolicy = 'refuse' | 'after-notice';

/** Options every core execute path takes. Required, so each caller states its policy. */
export interface ExecuteFundingOptions {
  assetSpend: AssetSpendPolicy;
}

/** Stable code for a refused asset spend. */
export type AssetSpendNotPermittedErrorCode = 'asset-spend-not-permitted';

/** What `AssetSpendNotPermittedError.toJSON()` returns. */
export interface AssetSpendNotPermittedErrorJson {
  name: 'AssetSpendNotPermittedError';
  code: AssetSpendNotPermittedErrorCode;
  message: string;
  /** The coin the flow would have spent, with what the scan named on it. */
  coin: FundingBlockedCoin;
  recommendation: {
    status: FundingRecommendation<AnnotatedFundingUtxo>['status'];
    recommended: FundingBlockedCoin | null;
    candidates: FundingBlockedCoin[];
  };
}

/** Thrown before signing when `assetSpend` is `'refuse'` and the coin to spend is not clean. */
export class AssetSpendNotPermittedError extends Error {
  readonly code: AssetSpendNotPermittedErrorCode = 'asset-spend-not-permitted';
  readonly coin: FundingBlockedCoin;
  readonly recommendation: AssetSpendNotPermittedErrorJson['recommendation'];

  constructor(coin: AnnotatedFundingUtxo, rec: FundingRecommendation<AnnotatedFundingUtxo>) {
    super(
      `The funding UTXO ${coin.txid}:${coin.vout} carries assets, and this caller may not spend an asset coin. ` +
        'Nothing was signed.',
    );
    this.name = 'AssetSpendNotPermittedError';
    this.coin = toFundingCoinJson(coin);
    this.recommendation = {
      status: rec.status,
      recommended: rec.recommended ? toFundingCoinJson(rec.recommended) : null,
      candidates: rec.candidates.map(toFundingCoinJson),
    };
  }

  /** The error as plain data, for an agent on the other side of a bridge. */
  toJSON(): AssetSpendNotPermittedErrorJson {
    return {
      name: 'AssetSpendNotPermittedError',
      code: this.code,
      message: this.message,
      coin: this.coin,
      recommendation: this.recommendation,
    };
  }
}

/**
 * True for an `AssetSpendNotPermittedError`, also one from another copy of the
 * SDK or another realm: it checks `name` and `code` rather than the prototype.
 */
export function isAssetSpendNotPermittedError(err: unknown): err is AssetSpendNotPermittedError {
  if (err instanceof AssetSpendNotPermittedError) {
    return true;
  }
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AssetSpendNotPermittedError' && e.code === 'asset-spend-not-permitted';
}

/**
 * The execute-path gate: under `'refuse'`, a coin to spend that is not clean
 * (named or unnamed assets, unchecked content), an explicit pin included,
 * throws before anything is signed.
 */
export function assertAssetSpendPermitted(
  options: ExecuteFundingOptions,
  coin: AnnotatedFundingUtxo,
  rec: FundingRecommendation<AnnotatedFundingUtxo>,
): void {
  if (options.assetSpend === 'refuse' && coin.bucket !== 'clean') {
    throw new AssetSpendNotPermittedError(coin, rec);
  }
}
