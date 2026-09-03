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

import { UtxoScanBucket } from '../cat21-mint/utxo-content.types';
import { FundingUtxo } from './coin-selection.helper';
import { selectCardinalUtxo } from './ord-coin-select';

/** A funding UTXO annotated with its content classification. */
export interface AnnotatedFundingUtxo extends FundingUtxo {
  /**
   * Content bucket from the scanner: `clean` = safe to spend, `assets` =
   * carries an inscription / rune / cat / rare sat (spending burns it),
   * `unscanned` / `scanning` = not known yet, `failed` = scan errored
   * (content unknown, treat as unsafe to auto-spend).
   */
  bucket: UtxoScanBucket;
}

/**
 * What the caller should do about funding:
 *   - `auto`             — a CLEAN UTXO covers the spend; `recommended` is
 *                          auto-selected. No coin picker needed (the default).
 *   - `expert-required`  — no clean UTXO covers, but an asset-bearing (or
 *                          scan-failed) one does. `recommended` is the best-fit
 *                          such coin, but the UI MUST confirm / offer the picker
 *                          before spending it (it would burn content).
 *   - `scanning`         — a covering candidate hasn't finished scanning; wait
 *                          for the scan, then re-evaluate. `recommended` null.
 *   - `insufficient`     — nothing covers the spend. `recommended` null.
 */
export type FundingRecommendationStatus = 'auto' | 'expert-required' | 'scanning' | 'insufficient';

export interface FundingRecommendation<T extends AnnotatedFundingUtxo = AnnotatedFundingUtxo> {
  status: FundingRecommendationStatus;
  /** The coin to use (best-fit). Null for `scanning` / `insufficient`. */
  recommended: T | null;
  /** The full annotated candidate list, for the expert-mode picker. */
  candidates: ReadonlyArray<T>;
}

/**
 * Decide funding for a spend of `targetSpendSats`, safely and automatically.
 *
 * Auto-selects the best-fit CLEAN covering UTXO (ord's `select_cardinal_utxo`
 * restricted to clean candidates). Falls back to `expert-required` only when
 * every covering candidate carries assets (or its scan failed), so a valuable
 * UTXO is never auto-spent. Returns `scanning` while a covering candidate's
 * content is still unknown, and `insufficient` when nothing covers.
 *
 * Same result shape for every action, so mint / transfer / offer / inscribe —
 * and every consumer (cat21.space, cat21-wallet, bots) — get identical
 * safe-auto + expert-with-recommendation behaviour.
 */
export function recommendFunding<T extends AnnotatedFundingUtxo>(
  candidates: ReadonlyArray<T>,
  targetSpendSats: number,
  preferredSpendSats?: number,
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

  // 3. Every covering candidate is scanned and carries assets (or its scan
  //    failed — content unknown). Never auto-spend those: recommend the best-fit
  //    covering coin but require expert confirmation.
  const best = selectCardinalUtxo(covering, targetSpendSats, false)!;
  return { status: 'expert-required', recommended: annotatedFor(best), candidates };
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
