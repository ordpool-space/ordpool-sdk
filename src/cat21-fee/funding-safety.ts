/**
 * Safe-by-default funding selection — the shared brain behind the coin-selection
 * UX vision for EVERY cat action (mint, transfer, offer, inscribe):
 *
 *   1. Comfortable AUTOMATIC selection by default — the user shouldn't see a
 *      coin picker to inscribe or transfer.
 *   2. But never auto-spend a valuable UTXO (one carrying an inscription, rune,
 *      cat, or rare sat). If only valuable UTXOs can pay, drop to EXPERT MODE
 *      and ask.
 *   3. Expert mode carries a RECOMMENDATION (the best-fit coin) but lets the
 *      user pick a different one.
 *
 * This is pure: it takes candidates already annotated with their content
 * `bucket` (from `UtxoContentScanner` / `classifyOutpoint`) and returns what to
 * do. The orchestrators run the scan, then call this. The "by value"
 * pick is ord's best-fit `selectCardinalUtxo`, so an auto-selected clean coin
 * stays byte-aligned with ord.
 */

import { UtxoScanBucket } from '../cat21-mint/utxo-content.types.js';
import { UtxoAssetDetail } from '../cat21-core/ports.js';
import { FundingUtxo } from './coin-selection.helper.js';
import { selectCardinalUtxo } from './ord-coin-select.js';

/** A funding UTXO annotated with its content classification. */
export interface AnnotatedFundingUtxo extends FundingUtxo {
  /**
   * Content bucket from the scanner: `clean` = safe to spend, `assets` =
   * carries an inscription / rune / cat / rare sat (spending burns it),
   * `unscanned` / `scanning` = not known yet, `failed` = scan errored
   * (content unknown, treat as unsafe to auto-spend).
   */
  bucket: UtxoScanBucket;
  /**
   * What the scan found, when the port reported it. Present so a caller can
   * NAME the assets rather than say "this coin carries assets" — a person
   * cannot consent to a loss they cannot see, and an agent deciding on an API
   * is making that same decision without a screen.
   */
  assets?: UtxoAssetDetail;
}

/**
 * What the caller should do about funding:
 *   - `auto`             — a CLEAN UTXO covers the spend; `recommended` is
 *                          auto-selected. No coin picker needed (the default).
 *   - `asset-notice`     — no clean UTXO covers, but a coin whose scan FOUND
 *                          assets (bucket `assets`) does, AND the wallet keeps a
 *                          separate payment address. Show a NOTICE naming what
 *                          the coin carries and PROCEED; do not block. Expert
 *                          mode stays available but is optional.
 *   - `expert-required`  — BLOCK until the user enters expert mode and
 *                          overrides. Two causes, told apart by
 *                          `recommended.bucket`:
 *                          `assets`: the same situation as `asset-notice` on a
 *                          wallet that uses ONE address for everything, where
 *                          assets and spending money share a lane.
 *                          `failed`: every covering coin that is not clean has
 *                          UNKNOWN content (its scan failed), on ANY topology.
 *                          Nothing can be named, so there is no notice to show,
 *                          and the warning says the content is unknown.
 *   - `scanning`         — a covering candidate hasn't finished scanning; wait
 *                          for the scan, then re-evaluate. `recommended` null.
 *   - `insufficient`     — nothing covers the spend. `recommended` null.
 *
 * For a coin with KNOWN assets, `asset-notice` and `expert-required` describe
 * the SAME coin risk; they differ only in how hard the UI stands in the way,
 * because the two wallet topologies make an accidental spend differently likely
 * and differently visible. A coin with UNKNOWN content is never behind a
 * notice: a notice that cannot say what is on the coin does not inform anyone,
 * so it cannot be the thing that enables the spend.
 */
export type FundingRecommendationStatus =
  | 'auto'
  | 'asset-notice'
  | 'expert-required'
  | 'scanning'
  | 'insufficient';

/**
 * How the connected wallet lays out its addresses.
 *
 * Derive it, never hardcode a wallet list: a wallet uses one address for
 * everything exactly when `walletInfo.paymentAddress ===
 * walletInfo.ordinalsAddress`. A name list rots silently the first time a
 * wallet changes its model, and the dangerous direction is a wallet that
 * COLLAPSES to one address while a stale list still calls it separate.
 */
export type WalletAddressTopology = 'separate-payment-address' | 'one-address-for-everything';

/**
 * True when this wallet keeps everything on one address, so its funding coins
 * and its assets share a lane.
 */
export function isOneAddressWallet(wallet: { paymentAddress: string; ordinalsAddress: string }): boolean {
  return wallet.paymentAddress === wallet.ordinalsAddress;
}

export interface FundingRecommendation<T extends AnnotatedFundingUtxo = AnnotatedFundingUtxo> {
  status: FundingRecommendationStatus;
  /** The coin to use (best-fit). Null for `scanning` / `insufficient`. */
  recommended: T | null;
  /** The full annotated candidate list, for the expert-mode picker. */
  candidates: ReadonlyArray<T>;
}

/**
 * What a STATEFUL caller (an orchestrator, a reactive service) was told about
 * its wallet's layout.
 *
 * `'derive'` means "work it out from the wallet context you already hold".
 * Offered because the alternative, making every consumer compute and pass the
 * value, is a thing each of them can forget, and forgetting is invisible: the
 * flow silently over-blocks and the notice simply never appears.
 *
 * Omitting the setting still blocks, but that is a guard against a caller who
 * FORGOT, not a policy about agents. An agent is treated exactly like a person:
 * both are entitled to the same answer and the same facts, one on a screen and
 * one on an API. So an agent passes `'derive'` too, and what makes its decision
 * safe is that the recommendation NAMES what it found (see `assets` on
 * `AnnotatedFundingUtxo`), not that the answer was withheld from it.
 */
export type FundingTopologySetting = WalletAddressTopology | 'derive';

/**
 * Resolve a caller's setting against the wallet it holds. `undefined` in,
 * `undefined` out, which `recommendFunding` reads as the blocking branch.
 */
export function resolveFundingTopology(
  setting: FundingTopologySetting | undefined,
  wallet: { paymentAddress: string; ordinalsAddress: string },
): WalletAddressTopology | undefined {
  if (setting === undefined) {
    return undefined;
  }
  if (setting === 'derive') {
    return isOneAddressWallet(wallet) ? 'one-address-for-everything' : 'separate-payment-address';
  }
  return setting;
}

/**
 * Decide funding for a spend of `targetSpendSats`, safely and automatically.
 *
 * Auto-selects the best-fit CLEAN covering UTXO (ord's `select_cardinal_utxo`
 * restricted to clean candidates). When no clean coin covers, a valuable UTXO
 * is never auto-spent: the answer is `asset-notice` or `expert-required` (see
 * `FundingRecommendationStatus`). Returns `scanning` while a covering
 * candidate's scan is unfinished, and `insufficient` when nothing covers.
 *
 * A coin whose scan FAILED is never auto-spent on any topology. Among dirty
 * covering coins the recommendation is the best-fit coin with KNOWN assets,
 * because only that one can carry a notice naming what it holds; a `failed`
 * coin is recommended only when no `assets` coin covers, and then the status
 * is `expert-required` regardless of topology. `recommended.bucket` is the
 * fact a person's warning and an agent's decision both read.
 *
 * Same result shape for every action, so mint / transfer / offer / inscribe —
 * and every consumer (cat21.space, cat21-wallet, bots) — get identical
 * safe-auto + expert-with-recommendation behaviour.
 */
export function recommendFunding<T extends AnnotatedFundingUtxo>(
  candidates: ReadonlyArray<T>,
  targetSpendSats: number,
  preferredSpendSats?: number,
  topology: WalletAddressTopology = 'one-address-for-everything',
): FundingRecommendation<T> {
  const covering = candidates.filter((c) => c.value >= targetSpendSats);
  if (covering.length === 0) {
    return { status: 'insufficient', recommended: null, candidates };
  }

  const annotatedFor = (u: FundingUtxo): T =>
    covering.find((c) => c.txid === u.txid && c.vout === u.vout)!;

  // 1. A clean UTXO covers → auto-select the best-fit clean one. The default.
  //    When a `preferredSpendSats` is given (the WITH-CHANGE + dust HEADROOM
  //    target, above the no-change feasibility `targetSpendSats`), bias toward a
  //    clean coin that clears it: such a coin leaves enough over the miner fee
  //    to emit an above-dust change output, so the realised fee-rate lands on
  //    the requested rate. A coin that only clears feasibility sits in the
  //    dust-cliff band (leftover-over-fee is sub-dust), so the builder absorbs
  //    that leftover into the fee — a 7-13% over-pay. Fall back to the best-fit
  //    coin over feasibility when NONE has headroom, so a wallet of only tight
  //    coins still spends (bounded, sub-dust over-pay), never a false
  //    `insufficient`.
  const cleanCovering = covering.filter((c) => c.bucket === 'clean');
  if (cleanCovering.length > 0) {
    const headroomTarget =
      preferredSpendSats !== undefined && preferredSpendSats > targetSpendSats
        ? preferredSpendSats
        : undefined;
    const headroomCoins =
      headroomTarget !== undefined ? cleanCovering.filter((c) => c.value >= headroomTarget) : [];
    const best =
      headroomTarget !== undefined && headroomCoins.length > 0
        ? selectCardinalUtxo(headroomCoins, headroomTarget, false)!
        : selectCardinalUtxo(cleanCovering, targetSpendSats, false)!;
    return { status: 'auto', recommended: annotatedFor(best), candidates };
  }

  // 2. No clean cover yet, but a covering candidate is still unscanned/scanning
  //    → the answer isn't final; wait for the scan.
  if (covering.some((c) => c.bucket === 'unscanned' || c.bucket === 'scanning')) {
    return { status: 'scanning', recommended: null, candidates };
  }

  // 3. Every covering candidate is scanned and either carries assets or its
  //    scan failed (content unknown). Never auto-spend those.
  //
  //    The recommendation is the best-fit among coins whose assets are KNOWN.
  //    A failed coin is recommended only when no such coin covers: a notice
  //    must name what the coin carries, and a failed coin has nothing to name,
  //    so it can never be the coin a notice waves through. Picking by value
  //    across both buckets would make the outcome depend on which coin happens
  //    to fit tighter, not on what the user can be told.
  //
  //    How hard to stand in the way of a KNOWN-asset coin depends on the
  //    wallet's address layout: on a separate-payment-address wallet a dirty
  //    funding coin is unusual and the user is assumed to know what a funding
  //    address is for, so inform and step aside; on a one-address wallet the
  //    assets and the spending money share a lane, so an accidental spend is
  //    likelier and less visible and a notice they can walk past is not enough.
  //    An UNKNOWN-content coin blocks on every topology.
  //
  //    Default topology is the blocking branch, so a caller that has not yet
  //    threaded its topology over-blocks rather than under-blocks.
  //
  //    The change-headroom bias above is deliberately NOT applied here: the pick
  //    is best-fit against FEASIBILITY, so it is the smallest coin that covers
  //    even when a larger one would clear `preferredSpendSats` and avoid the
  //    dust-fold. In a pool where every covering coin carries something,
  //    spending the least is worth more than avoiding a sub-dust over-pay, and
  //    biasing toward the bigger coin could burn the more valuable asset.
  //    Consequence a surface must RENDER rather than hide: the recommended row
  //    can carry an over-pay flag at the same time as the recommendation.
  const knownAssets = covering.filter((c) => c.bucket === 'assets');
  const pool = knownAssets.length > 0 ? knownAssets : covering;
  const recommended = annotatedFor(selectCardinalUtxo(pool, targetSpendSats, false)!);
  const status: FundingRecommendationStatus =
    recommended.bucket === 'assets' && topology === 'separate-payment-address'
      ? 'asset-notice'
      : 'expert-required';
  return { status, recommended, candidates };
}

/**
 * The error a flow throws when it stops on `expert-required` with no explicit
 * pick. It names the cause the recommendation carries, so a caller reading
 * only the message (an agent, a log) learns the same fact a warning shows: the
 * covering coin's content is unknown (`failed`), or it carries assets.
 * Both texts start with `Select a funding UTXO`, which consumers match on.
 */
export function expertRequiredMessage(rec: { recommended: { bucket: UtxoScanBucket } | null }): string {
  return rec.recommended?.bucket === 'failed'
    ? 'Select a funding UTXO (what the covering coins hold could not be checked)'
    : 'Select a funding UTXO (the available coins carry assets)';
}

/**
 * Re-key a recommendation onto a richer source type by outpoint. The core
 * flows return `FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>`;
 * a consumer that holds fuller UTXO objects (e.g. `TxnOutput` with confirmation
 * status) uses this to lift the recommendation back into its own type — the
 * scan annotation is preserved, the source object supplies its extra fields.
 * Candidates with no matching outpoint in `source` are dropped.
 */
export function liftRecommendationByOutpoint<
  S extends AnnotatedFundingUtxo,
  T extends { txid: string; vout: number },
>(
  rec: FundingRecommendation<S>,
  source: readonly T[],
): FundingRecommendation<T & AnnotatedFundingUtxo> {
  const byOutpoint = new Map(source.map((u) => [`${u.txid}:${u.vout}`, u] as const));
  const lift = (c: S): (T & AnnotatedFundingUtxo) | null => {
    const u = byOutpoint.get(`${c.txid}:${c.vout}`);
    return u ? ({ ...c, ...u } as T & AnnotatedFundingUtxo) : null;
  };
  return {
    status: rec.status,
    recommended: rec.recommended ? lift(rec.recommended) : null,
    candidates: rec.candidates.map(lift).filter((x): x is T & AnnotatedFundingUtxo => x !== null),
  };
}
