/**
 * Pure classification of one outpoint's ordinals content, shared by the
 * stateful `UtxoContentScanner` (cached) and the watch-only probe
 * (`classifyOutpoint` / `makeWatchOnlyProbe`). Both fetch the same two ord
 * responses (via `fetch`) through different
 * HTTP layers, then hand them here so the "is this UTXO spendable" decision
 * has ONE implementation and cannot drift between the consumers.
 *
 * A UTXO is `clean` (safe to spend as funding) only when ord has INDEXED it
 * and it carries no inscription, no rune, no CAT-21 cat, and no rare sat.
 * Anything else is ordinals content a watch-only user could burn if it were
 * spent for fees.
 *
 * The indexed half matters as much as the content half: ord answers 200 with
 * empty fields both for an output it has not indexed and for one that is
 * genuinely empty, so a classifier that only looks at content reports an
 * unindexed output as safe to spend.
 */

import { findRareSatInRanges, SatRarity } from './sat-rarity.helper.js';
import {
  Cat21OrdOutputResponse,
  OrdOutputResponse,
  RARE_SAT_MAX_RANGES,
} from './utxo-content.types.js';

export interface UtxoContentClassification {
  /** No inscription, rune, cat, or rare sat: safe to spend as funding. */
  clean: boolean;
  /**
   * Whether the full ord has actually INDEXED this output.
   *
   * ord answers 200 with empty fields for an output whose block it has not
   * finished indexing, which is byte-identical to its answer for an output
   * that genuinely carries nothing. Absence of data is not absence of assets,
   * and reading it as `clean` spends the coin.
   */
  indexed: boolean;
  inscriptionIds: string[];
  runes: { [runeName: string]: unknown } | null;
  catIds: string[];
  /** Sat the cats sit on (offset 0), or null when no cats / no ranges. */
  catSat: number | null;
  rareSat: { sat: string; block: number; rarity: SatRarity } | null;
}

/**
 * Merge the full-ord response (inscriptions + runes + sat_ranges) and the
 * cat21-ord response (cats) into one classification. Pure: no I/O.
 */
export function classifyUtxoContent(
  ord: OrdOutputResponse,
  cat21Ord: Cat21OrdOutputResponse,
): UtxoContentClassification {
  const inscriptionIds = ord.inscriptions ?? [];
  const runes = ord.runes && Object.keys(ord.runes).length > 0 ? ord.runes : null;
  const catIds = cat21Ord.cats ?? [];
  const rareSat = detectRareSat(ord.sat_ranges);

  // Every output ord has indexed carries sat ranges, because the scanner
  // requires an ord running `--index-sats` (rare-sat detection depends on it).
  // So empty ranges mean one of two things, and both must fail CLOSED: ord has
  // not indexed this output yet, or it is running without `--index-sats` and
  // cannot answer the question at all. Treating either as "no assets here" is
  // how a freshly-confirmed inscription gets spent for fees.
  const indexed = (ord.sat_ranges?.length ?? 0) > 0;

  const clean = indexed && inscriptionIds.length === 0 && !runes && catIds.length === 0 && !rareSat;

  // Source the cat's sat from cat21-ord (the cat indexer, authoritative and
  // always in step with `cats`); fall back to the full ord only if cat21-ord
  // returned no ranges. Reading it from the full ord alone yielded catSat=null
  // whenever that instance had not indexed the output.
  const catSat = catIds.length > 0
    ? (firstSat(cat21Ord.sat_ranges) ?? firstSat(ord.sat_ranges))
    : null;

  return { clean, indexed, inscriptionIds, runes, catIds, catSat, rareSat };
}

/**
 * First sat of the first range, where a CAT-21 cat sits.
 *
 * The protocol pins a cat to offset 0 of its output, so the ranges do not
 * need walking: the opening sat of the first range is the cat's sat. Returns
 * null when ord supplied no ranges (an output it has not indexed).
 */
export function firstSat(
  ranges: ReadonlyArray<readonly [number, number]> | undefined,
): number | null {
  const first = ranges?.[0]?.[0];
  return typeof first === 'number' ? first : null;
}

/**
 * Turn ord's `sat_ranges` into a rare-sat finding if one exists. Skips the
 * scan when the range count exceeds `RARE_SAT_MAX_RANGES` — pathological
 * UTXOs with thousands of ranges would dominate the per-UTXO cost budget.
 */
export function detectRareSat(
  ranges: ReadonlyArray<readonly [number, number]> | undefined,
): { sat: string; block: number; rarity: SatRarity } | null {
  if (!ranges || ranges.length === 0 || ranges.length > RARE_SAT_MAX_RANGES) return null;
  const bigints = ranges.map(([start, end]) => [BigInt(start), BigInt(end)] as [bigint, bigint]);
  const hit = findRareSatInRanges(bigints);
  if (!hit) return null;
  return { sat: hit.sat.toString(), block: hit.block, rarity: hit.rarity };
}
