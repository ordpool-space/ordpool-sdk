import { FundingUtxo } from '../cat21-fee/coin-selection.helper.js';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  recommendFunding,
  WalletAddressTopology,
} from '../cat21-fee/funding-safety.js';
import { UtxoScanBucket } from '../cat21-mint/utxo-content.types.js';
import { classificationAssets, classificationVerdict, ContentScanPort, namesAssets, UtxoAssetDetail } from './ports.js';

const outpoint = (u: FundingUtxo): string => `${u.txid}:${u.vout}`;

/**
 * One coin's content as the funding policy reads it: the port's verdict as a
 * bucket (`clean` / `assets`, `failed` when the scan rejects) plus the detail
 * it named. The detail travels as the port reported it, so a caller can name
 * what was found; whether it names anything is `recommendFunding`'s call
 * (`namesAssets`), so an empty detail travels too and reads as unnamed there.
 */
export async function classifyFundingCoin(
  scan: ContentScanPort,
  outpointKey: string,
): Promise<Required<Pick<FundingPinContent, 'bucket'>> & Pick<FundingPinContent, 'assets'>> {
  try {
    const classification = await scan.classify(outpointKey);
    const assets = classificationAssets(classification);
    return {
      bucket: classificationVerdict(classification) === 'clean' ? 'clean' : 'assets',
      ...(assets ? { assets } : {}),
    };
  } catch {
    return { bucket: 'failed' };
  }
}

/**
 * Content-checked coin selection — the async, port-driven form of
 * `FundingRecommendationService`. Force-classifies every COVERING candidate via
 * the `ContentScanPort` (regardless of size, so the "never auto-spend a valuable
 * coin" guarantee holds even for large funding UTXOs), then applies the pure
 * `recommendFunding`:
 *
 * - a content-clean coin covers  -> `auto` (auto-selected, no picker)
 * - only asset coins cover, the port NAMED the assets (`namesAssets`), and
 *   the wallet keeps a SEPARATE payment address
 *                                -> `asset-notice` (proceed, but say what the
 *                                   coin carries)
 * - only named-asset coins cover, and the wallet uses ONE address for
 *   everything                   -> `expert-required` (block; surface the picker)
 * - the port answers `has-assets` without naming anything (the bare string,
 *   or an object whose detail is absent or names nothing)
 *                                -> that coin is an UNNAMED-asset coin; when no
 *                                   clean or named-asset coin covers,
 *                                   `expert-required` on every topology,
 *                                   cause `unnamed-assets`
 * - a covering coin's scan fails -> that coin is `failed`, never auto-spent;
 *                                   when no clean or asset coin covers,
 *                                   `expert-required` on every topology,
 *                                   cause `unknown-content`
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
  const assetsByOutpoint = new Map<string, UtxoAssetDetail>();
  await Promise.all(
    utxos
      .filter((u) => u.value >= targetSats)
      .map(async (u) => {
        const content = await classifyFundingCoin(scan, outpoint(u));
        bucketByOutpoint.set(outpoint(u), content.bucket);
        if (content.assets) {
          assetsByOutpoint.set(outpoint(u), content.assets);
        }
      }),
  );

  const annotated = utxos.map((u): T & AnnotatedFundingUtxo => {
    const detail = assetsByOutpoint.get(outpoint(u));
    return {
      ...u,
      bucket: bucketByOutpoint.get(outpoint(u)) ?? 'unscanned',
      ...(detail ? { assets: detail } : {}),
    };
  });
  return recommendFunding(annotated, targetSats, preferredSats, topology);
}

/**
 * Resolve the funding coin a flow will spend:
 *
 * - the user's EXPLICIT expert-mode pick when it still covers the target and
 *   carries nothing beyond what was shown when it was pinned, honoured even
 *   when it carries assets, because they chose it with those assets in view;
 * - otherwise the recommended coin when the flow may PROCEED, which is `auto`
 *   (a clean coin covers) and `asset-notice` (only a coin with NAMED assets
 *   covers, but the wallet keeps a separate payment address, so the UI informs
 *   rather than obstructs);
 * - otherwise null, which is what BLOCKS the flow: `expert-required` (a
 *   one-address wallet, or a recommended coin whose assets are unnamed or
 *   whose content is unknown because its scan failed; the user must override
 *   deliberately), `scanning`, `insufficient`.
 *
 * Returning the coin on `asset-notice` is the half of the policy that makes it
 * a notice and not a wall. The UI still owes the user the notice; this only
 * decides whether a coin is available to spend.
 */
/**
 * Why an explicit pick is not the coin that will be spent.
 *
 * `gone`: the outpoint left the candidate set. `below-requirement`: still
 * there, no longer covers at this rate. `contents-changed`: still there and
 * covering, but the scan now finds something on it that was not shown when it
 * was pinned (`pinContentHeld`). Different remedies, so a reason rather than a
 * boolean.
 */
export interface DroppedSelection {
  txid: string;
  vout: number;
  reason: 'gone' | 'below-requirement' | 'contents-changed';
}

/**
 * What the person saw on a pinned coin when they chose it: its scan bucket and
 * the assets the scan named. Absent means they saw nothing on it, which is
 * read as `clean`.
 */
export type FundingPinContent = Partial<Pick<AnnotatedFundingUtxo, 'bucket' | 'assets'>>;

/** A pinned funding coin: its outpoint, plus what was shown on it when it was chosen. */
export type FundingPin = { txid: string; vout: number } & FundingPinContent;

const namedAssetKeys = (d: UtxoAssetDetail | undefined): string[] => d
  ? [
      ...d.inscriptionIds.map((id) => `inscription:${id}`),
      ...d.runeNames.map((name) => `rune:${name}`),
      ...d.catIds.map((id) => `cat:${id}`),
      ...(d.rareSat ? [`rare-sat:${d.rareSat.sat}`] : []),
    ]
  : [];

/**
 * Whether a pinned coin still carries nothing beyond what was shown when it was
 * pinned. A coin now clean always passes. A coin that now carries assets passes
 * only when it was shown with assets and every asset the scan names now was
 * named then; an unnamed answer passes only against an unnamed one. A failed
 * or missing scan passes only against the same bucket. A pin with no content
 * was shown as clean.
 */
export function pinContentHeld(pin: FundingPinContent, current: AnnotatedFundingUtxo): boolean {
  if (current.bucket === 'clean') return true;
  const shown = pin.bucket ?? 'clean';
  if (current.bucket !== 'assets') return shown === current.bucket;
  if (shown !== 'assets') return false;
  if (!namesAssets(current.assets)) return !namesAssets(pin.assets);
  const seen = new Set(namedAssetKeys(pin.assets));
  return namedAssetKeys(current.assets).every((k) => seen.has(k));
}

/**
 * The pick, plus why an explicit selection was replaced.
 *
 * Rendering only the resolved coin is correct about the spend and silent about
 * the swap. A consumer comparing outpoints to detect it is re-deriving funding
 * policy, which the asset-safety rule forbids.
 */
export function describeFundingPick<T extends AnnotatedFundingUtxo>(
  recommendation: FundingRecommendation<T>,
  target: number,
  explicitSelection?: FundingPin | null,
): { pick: T | null; droppedSelection: DroppedSelection | null } {
  const stillPresent = explicitSelection
    ? recommendation.candidates.find(
        (c) => c.txid === explicitSelection.txid && c.vout === explicitSelection.vout,
      )
    : undefined;
  const covers = stillPresent !== undefined && stillPresent.value >= target;
  const contentHeld = covers && explicitSelection ? pinContentHeld(explicitSelection, stillPresent) : false;
  if (stillPresent && covers && contentHeld) {
    return { pick: stillPresent, droppedSelection: null };
  }
  const mayProceed =
    recommendation.status === 'auto' || recommendation.status === 'asset-notice';
  const pick = mayProceed ? recommendation.recommended : null;
  const droppedSelection: DroppedSelection | null = explicitSelection
    ? {
        txid: explicitSelection.txid,
        vout: explicitSelection.vout,
        reason: !stillPresent ? 'gone' : covers ? 'contents-changed' : 'below-requirement',
      }
    : null;
  return { pick, droppedSelection };
}

/** The pick alone, for a caller that does not render the drop. */
export function resolveFundingPick<T extends AnnotatedFundingUtxo>(
  recommendation: FundingRecommendation<T>,
  target: number,
  explicitSelection?: FundingPin | null,
): T | null {
  return describeFundingPick(recommendation, target, explicitSelection).pick;
}
