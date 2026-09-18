import { FundingUtxo } from '../cat21-fee/coin-selection.helper.js';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  recommendFunding,
  WalletAddressTopology,
} from '../cat21-fee/funding-safety.js';
import { UtxoScanBucket } from '../cat21-mint/utxo-content.types.js';
import { ContentScanPort } from './ports.js';

const outpoint = (u: FundingUtxo): string => `${u.txid}:${u.vout}`;

/**
 * Content-checked coin selection — the async, port-driven form of
 * `FundingRecommendationService`. Force-classifies every COVERING candidate via
 * the `ContentScanPort` (regardless of size, so the "never auto-spend a valuable
 * coin" guarantee holds even for large funding UTXOs), then applies the pure
 * `recommendFunding`:
 *
 * - a content-clean coin covers  -> `auto` (auto-selected, no picker)
 * - only asset coins cover, and the wallet keeps a SEPARATE payment address
 *                                -> `asset-notice` (proceed, but say what the
 *                                   coin carries)
 * - only asset coins cover, and the wallet uses ONE address for everything
 *                                -> `expert-required` (block; surface the picker)
 * - a covering coin's scan fails -> that coin is `failed` (never auto-spent)
 * - nothing covers               -> `insufficient`
 *
 * Non-covering coins stay `unscanned` (never auto-picked anyway, so no wasted
 * scan). No RxJS — the wallet and bots consume it as plain async;
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
  topology?: WalletAddressTopology,
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
  return recommendFunding(annotated, targetSats, preferredSats, topology);
}

/**
 * Resolve the funding coin a flow will spend:
 *
 * - the user's EXPLICIT expert-mode pick when it still covers the target,
 *   honoured even when it carries assets, because they chose it;
 * - otherwise the recommended coin when the flow may PROCEED, which is `auto`
 *   (a clean coin covers) and `asset-notice` (only a dirty coin covers, but the
 *   wallet keeps a separate payment address, so the UI informs rather than
 *   obstructs);
 * - otherwise null, which is what BLOCKS the flow: `expert-required` (a
 *   one-address wallet, where the user must override deliberately), `scanning`,
 *   `insufficient`.
 *
 * Returning the coin on `asset-notice` is the half of the policy that makes it
 * a notice and not a wall. The UI still owes the user the notice; this only
 * decides whether a coin is available to spend.
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
  const mayProceed =
    recommendation.status === 'auto' || recommendation.status === 'asset-notice';
  return mayProceed ? recommendation.recommended : null;
}
