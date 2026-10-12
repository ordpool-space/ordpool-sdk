/**
 * The error every funding flow throws when its recommendation is
 * `expert-required` and the caller made no explicit pick.
 *
 * A person sees a disabled CTA, a warning and a coin picker. An agent sees
 * this error, and it carries the same facts: why the flow stopped (`cause`),
 * which coin the SDK recommends, what that coin carries, and every candidate
 * the picker would list. A message string alone would leave an agent to parse
 * prose for the outpoint it has to decide about.
 *
 * Every field is plain JSON (strings, numbers, arrays, null), so the error
 * crosses an MCP bridge or a `postMessage` boundary through `toJSON()` with
 * nothing lost.
 */

import { UtxoAssetDetail } from '../cat21-core/ports.js';
import { UtxoScanBucket } from '../cat21-mint/utxo-content.types.js';
import {
  AnnotatedFundingUtxo,
  ExpertRequiredCause,
  FundingRecommendation,
  expertRequiredCause,
  expertRequiredMessage,
} from './funding-safety.js';

/** Stable code for a blocked funding decision. */
export type FundingBlockedErrorCode = 'funding-blocked';

/** One coin as the blocked recommendation reports it. */
export interface FundingBlockedCoin {
  txid: string;
  vout: number;
  value: number;
  /** The scan's verdict on this coin (`assets`, `failed`, `clean`, ...). */
  bucket: UtxoScanBucket;
  /** What the scan named on this coin, or `null` when it named nothing. */
  assets: UtxoAssetDetail | null;
}

/** The recommendation that blocked, reduced to plain data. */
export interface FundingBlockedRecommendation {
  status: 'expert-required';
  /** The coin the SDK recommends, and the one the cause describes. */
  recommended: FundingBlockedCoin;
  /** Every candidate the recommendation considered, as the coin picker lists them. */
  candidates: FundingBlockedCoin[];
}

/** What `FundingBlockedError.toJSON()` returns. */
export interface FundingBlockedErrorJson {
  name: 'FundingBlockedError';
  code: FundingBlockedErrorCode;
  message: string;
  cause: ExpertRequiredCause;
  recommendation: FundingBlockedRecommendation;
}

function toBlockedCoin(c: AnnotatedFundingUtxo): FundingBlockedCoin {
  return {
    txid: c.txid,
    vout: c.vout,
    value: c.value,
    bucket: c.bucket,
    assets: c.assets
      ? {
          inscriptionIds: [...c.assets.inscriptionIds],
          runeNames: [...c.assets.runeNames],
          catIds: [...c.assets.catIds],
          rareSat: c.assets.rareSat ? { ...c.assets.rareSat } : null,
        }
      : null,
  };
}

/**
 * Thrown when funding stops on `expert-required`.
 *
 * `message` is `expertRequiredMessage(rec)` and starts with
 * `Select a funding UTXO`, which consumers match on. `code` is a plain string
 * and survives a realm or serialisation boundary where `instanceof` does not;
 * `isFundingBlockedError` checks it.
 *
 * `cause` is the `ExpertRequiredCause`, a string, and it takes the slot
 * ES2022 reserves for an underlying error: this error wraps none.
 *
 * Insufficient funds and an unfinished scan are not this error: both throw a
 * plain `Error` (`Insufficient funds for ...`, `Still checking what the
 * funding coins hold ...`), because neither has a coin for anyone to decide
 * about.
 */
export class FundingBlockedError extends Error {
  readonly code: FundingBlockedErrorCode = 'funding-blocked';
  override readonly cause: ExpertRequiredCause;
  readonly recommendation: FundingBlockedRecommendation;

  /**
   * Throws a plain `Error` when `rec` is not a blocking recommendation (not
   * `expert-required`, or with no non-clean recommended coin): every flow
   * builds this error only from `expert-required`, and `recommendFunding`
   * returns that status only with a covering coin that carries assets or
   * failed its scan.
   */
  constructor(rec: FundingRecommendation<AnnotatedFundingUtxo>) {
    const cause = expertRequiredCause(rec);
    if (rec.status !== 'expert-required' || !rec.recommended || cause === null) {
      throw new Error(
        `FundingBlockedError needs an expert-required recommendation with a non-clean recommended coin, got status ${rec.status}`,
      );
    }
    super(expertRequiredMessage(rec));
    this.name = 'FundingBlockedError';
    this.cause = cause;
    this.recommendation = {
      status: 'expert-required',
      recommended: toBlockedCoin(rec.recommended),
      candidates: rec.candidates.map(toBlockedCoin),
    };
  }

  /** The error as plain data, for an agent on the other side of a bridge. */
  toJSON(): FundingBlockedErrorJson {
    return {
      name: 'FundingBlockedError',
      code: this.code,
      message: this.message,
      cause: this.cause,
      recommendation: this.recommendation,
    };
  }
}

/**
 * True for a `FundingBlockedError`, also one from another copy of the SDK or
 * another realm: it checks `name` and `code` rather than the prototype.
 */
export function isFundingBlockedError(err: unknown): err is FundingBlockedError {
  if (err instanceof FundingBlockedError) {
    return true;
  }
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'FundingBlockedError' && e.code === 'funding-blocked';
}
