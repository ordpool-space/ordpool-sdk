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
 */
export async function selectFunding<T extends FundingUtxo>(
  utxos: ReadonlyArray<T>,
  targetSats: number,
  scan: ContentScanPort,
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
  return recommendFunding(annotated, targetSats);
}
