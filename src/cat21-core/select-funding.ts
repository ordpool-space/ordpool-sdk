import { FundingUtxo } from '../cat21-fee/coin-selection.helper';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  recommendFunding,
} from '../cat21-fee/funding-safety';
import { UtxoScanBucket } from '../cat21-mint/utxo-content.types';
import { ContentScanPort } from './ports';

const outpoint = (u: FundingUtxo): string => `${u.txid}:${u.vout}`;

/**
 * Content-checked coin selection — the async, port-driven form of the Angular
 * `FundingRecommendationService`. Force-classifies every COVERING candidate via
 * the `ContentScanPort` (regardless of size, so the "never auto-spend a valuable
 * coin" guarantee holds even for large funding UTXOs), then applies the pure
 * `recommendFunding`:
 *
 * - a content-clean coin covers  -> `auto` (auto-selected, no picker)
 * - only asset coins cover       -> `expert-required` (surface the picker)
 * - a covering coin's scan fails -> that coin is `failed` (never auto-spent)
 * - nothing covers               -> `insufficient`
 *
 * Non-covering coins stay `unscanned` (never auto-picked anyway, so no wasted
 * scan). No RxJS, no Angular — the wallet and bots consume it as plain async;
 * cat21.space wraps it in its reactive veneer.
 *
 * `preferredSats` (optional) is the WITH-CHANGE + dust headroom target, above
 * the no-change feasibility `targetSats`. When given, the auto-pick is biased
 * toward a clean coin that clears it, so the tx emits an above-dust change and
 * the realised fee-rate lands on the requested rate instead of absorbing a
 * sub-dust leftover into the fee (a dust-cliff over-pay). It only biases the
 * pick; `targetSats` stays the coverage gate, so a wallet of only tight coins
 * still selects one (bounded over-pay, never a false `insufficient`).
 */
export async function selectFunding<T extends FundingUtxo>(
  utxos: ReadonlyArray<T>,
  targetSats: number,
  scan: ContentScanPort,
  preferredSats?: number,
): Promise<FundingRecommendation<T & AnnotatedFundingUtxo>> {
  if (!targetSats || targetSats <= 0 || utxos.length === 0) {
    return recommendFunding<T & AnnotatedFundingUtxo>([], targetSats > 0 ? targetSats : 0);
  }

  const bucketByOutpoint = new Map<string, UtxoScanBucket>();
  await Promise.all(
    utxos
      .filter((u) => u.value >= targetSats)
      .map(async (u) => {
        try {
          const verdict = await scan.classify(outpoint(u));
          bucketByOutpoint.set(outpoint(u), verdict === 'clean' ? 'clean' : 'assets');
        } catch {
          bucketByOutpoint.set(outpoint(u), 'failed');
        }
      }),
  );

  const annotated = utxos.map(
    (u): T & AnnotatedFundingUtxo => ({
      ...u,
      bucket: bucketByOutpoint.get(outpoint(u)) ?? 'unscanned',
    }),
  );
  return recommendFunding(annotated, targetSats, preferredSats);
}

/**
 * Resolve the funding coin a flow will spend: the user's EXPLICIT expert-mode
 * pick when it still covers the target (honoured even if it carries assets —
 * they chose it), otherwise the SAFE auto coin (only when a content-clean coin
 * covers, i.e. `status: 'auto'`). Returns null when there is no safe auto-pick
 * and no explicit override — the flow then surfaces the picker / an error.
 */
export function resolveFundingPick<T extends AnnotatedFundingUtxo>(
  recommendation: FundingRecommendation<T>,
  target: number,
  explicitSelection?: { txid: string; vout: number } | null,
): T | null {
  const stillPresent = explicitSelection
    ? recommendation.candidates.find(
        (c) => c.txid === explicitSelection.txid && c.vout === explicitSelection.vout,
      )
    : undefined;
  if (stillPresent && stillPresent.value >= target) return stillPresent;
  return recommendation.status === 'auto' ? recommendation.recommended : null;
}
