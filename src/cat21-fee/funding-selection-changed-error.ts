/**
 * The error every execute path throws when the caller pinned a funding coin
 * and that coin is no longer the one that would be spent: it left the wallet's
 * coin set (`gone`), or it no longer covers the action at this fee rate
 * (`below-requirement`).
 *
 * The plan would otherwise fall back to the SDK's own recommendation, a coin
 * the caller never confirmed. On a separate-payment-address wallet that coin
 * can carry assets (`asset-notice`), so spending it without asking again would
 * spend an asset the user was never shown. The error stops before anything is
 * signed and carries what a new confirmation needs: which pick was dropped and
 * why, and the fresh recommendation with every candidate.
 *
 * Every field is plain JSON, so the error crosses an MCP bridge or a
 * `postMessage` boundary through `toJSON()` with nothing lost.
 */

import type { DroppedSelection } from '../cat21-core/select-funding.js';
import { AnnotatedFundingUtxo, FundingRecommendation } from './funding-safety.js';
import type { FundingBlockedCoin } from './funding-blocked-error.js';
import { toFundingCoinJson } from './funding-coin-json.js';

/** Stable code for a dropped funding pick. */
export type FundingSelectionChangedErrorCode = 'funding-selection-changed';

/** The fresh recommendation, reduced to plain data. */
export interface FundingSelectionChangedRecommendation {
  status: FundingRecommendation<AnnotatedFundingUtxo>['status'];
  /** The coin the SDK would spend instead, or `null` when it would spend none. */
  recommended: FundingBlockedCoin | null;
  /** Every candidate the recommendation considered, as the coin picker lists them. */
  candidates: FundingBlockedCoin[];
}

/** What `FundingSelectionChangedError.toJSON()` returns. */
export interface FundingSelectionChangedErrorJson {
  name: 'FundingSelectionChangedError';
  code: FundingSelectionChangedErrorCode;
  message: string;
  droppedSelection: DroppedSelection;
  recommendation: FundingSelectionChangedRecommendation;
}

/**
 * Thrown by `executeMint`, `executeTransfer`, `createOffer` and
 * `executeInscribe` when `selectedFundingUtxo` was passed and the plan dropped
 * it. A pinned coin that is still present and covers is spent as before, even
 * when it carries assets: the caller chose it.
 *
 * `code` is a plain string and survives a realm or serialisation boundary
 * where `instanceof` does not; `isFundingSelectionChangedError` checks it.
 */
export class FundingSelectionChangedError extends Error {
  readonly code: FundingSelectionChangedErrorCode = 'funding-selection-changed';
  readonly droppedSelection: DroppedSelection;
  readonly recommendation: FundingSelectionChangedRecommendation;

  constructor(droppedSelection: DroppedSelection, rec: FundingRecommendation<AnnotatedFundingUtxo>) {
    super(
      droppedSelection.reason === 'gone'
        ? `The selected funding UTXO ${droppedSelection.txid}:${droppedSelection.vout} is no longer available. Confirm a funding UTXO again.`
        : `The selected funding UTXO ${droppedSelection.txid}:${droppedSelection.vout} no longer covers this action at the current fee rate. Confirm a funding UTXO again.`,
    );
    this.name = 'FundingSelectionChangedError';
    this.droppedSelection = { ...droppedSelection };
    this.recommendation = {
      status: rec.status,
      recommended: rec.recommended ? toFundingCoinJson(rec.recommended) : null,
      candidates: rec.candidates.map(toFundingCoinJson),
    };
  }

  /** The error as plain data, for an agent on the other side of a bridge. */
  toJSON(): FundingSelectionChangedErrorJson {
    return {
      name: 'FundingSelectionChangedError',
      code: this.code,
      message: this.message,
      droppedSelection: this.droppedSelection,
      recommendation: this.recommendation,
    };
  }
}

/**
 * True for a `FundingSelectionChangedError`, also one from another copy of the
 * SDK or another realm: it checks `name` and `code` rather than the prototype.
 */
export function isFundingSelectionChangedError(err: unknown): err is FundingSelectionChangedError {
  if (err instanceof FundingSelectionChangedError) {
    return true;
  }
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'FundingSelectionChangedError' && e.code === 'funding-selection-changed';
}

/**
 * The execute-path guard: throws `FundingSelectionChangedError` when the
 * caller pinned a coin (`selected`) and the plan dropped it. A pinned coin
 * that the plan dropped is not silently replaced, because the fallback is a
 * coin the caller never confirmed, and on a separate-address wallet it can
 * carry assets the user was never shown.
 */
export function assertPinnedFundingHeld(
  selected: { txid: string; vout: number } | null | undefined,
  plan: { droppedSelection: DroppedSelection | null; recommendation: FundingRecommendation<AnnotatedFundingUtxo> },
): void {
  if (selected && plan.droppedSelection) {
    throw new FundingSelectionChangedError(plan.droppedSelection, plan.recommendation);
  }
}
