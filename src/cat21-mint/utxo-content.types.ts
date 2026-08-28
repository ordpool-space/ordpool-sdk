/**
 * Asset-detection types for the mint flow's UTXO scanner. We query
 * BOTH our ord instance (`ord.ordpool.space`, returns regular
 * inscriptions + runes) AND our cat21-ord (`ord.cat21.space`, returns
 * CAT-21 cats) per outpoint, merging the answers into one
 * `UtxoContent`. Rare-sat classification is derived client-side from
 * ord's `sat_ranges` via `sat-rarity.helper.ts`.
 *
 * The detection is content-safety, not fee-math: an inscription at the
 * dust limit (546 sat) reads as "tiny UTXO" to the picker but carries
 * arbitrary off-chain value. On single-address wallets, spending such
 * a UTXO as a mint input sends the asset to the miner as fee. The same
 * risk applies to a UTXO carrying a rare sat.
 */

import type { SatRarity } from './sat-rarity.helper';

/**
 * Raw `/output/{outpoint}` shape returned by ord with the JSON API
 * enabled. The subset we read here.
 *
 * `sat_ranges` — array of `[start, end)` tuples of sat numbers this
 *   output holds. Can be enormous for wide / mixed UTXOs (thousands
 *   of tuples, MBs of payload). The scanner gates rare-sat detection
 *   behind a small-UTXO threshold + range-count cap so the naive
 *   "fetch everything, scan all ranges" cost doesn't dominate.
 */
export interface OrdOutputResponse {
  inscriptions?: string[];
  runes?: { [runeName: string]: unknown } | null;
  sat_ranges?: ReadonlyArray<readonly [number, number]>;
}

/**
 * Same shape from cat21-ord. The fork swaps the `inscriptions` field
 * for `cats` because `--index-cat21` only indexes CAT-21 fake-
 * inscriptions and explicitly excludes everything else. Runes are
 * never indexed by cat21-ord, so the field is always `null` there.
 */
export interface Cat21OrdOutputResponse {
  cats?: string[];
  /**
   * cat21-ord runs with `--index-sats`, so its `/output` carries the same
   * `sat_ranges` a full ord does. This is the AUTHORITATIVE source for a
   * cat's sat (cat21-ord is the cat indexer); the full-ord instance can lag
   * on an output it hasn't indexed yet, so the scanner reads the cat's sat
   * from here first.
   */
  sat_ranges?: ReadonlyArray<readonly [number, number]>;
}

/**
 * Aggregated content found at a single UTXO. Populated only when at
 * least one of the asset arrays is non-empty — clean UTXOs use the
 * `scanned-clean` scan-state variant instead of a `UtxoContent` with
 * empty arrays.
 */
export interface UtxoContent {
  /** "txid:vout" — the outpoint we queried. */
  outpoint: string;
  /** Inscription IDs at this outpoint, in ord's standard `{txid}i{index}` format. */
  inscriptionIds: string[];
  /**
   * Rune name → balance object, exactly as ord's `/output/` endpoint
   * returns it. `null` when the upstream didn't supply a runes field
   * (cat21-ord) or returned `{}` (no runes here).
   */
  runes: { [runeName: string]: unknown } | null;
  /** CAT-21 cat IDs at this outpoint, also in `{txid}i{index}` format. */
  catIds: string[];
  /**
   * Sat the cats at this outpoint sit on, or `null` when the outpoint holds
   * no cats or ord returned no sat ranges.
   *
   * CAT-21 pins a cat to offset 0 of its output (FIFO), so every cat here
   * shares the first sat of the first range. That makes the sat derivable from
   * the scan alone, with no per-cat lookup, and it is what a UI should link to:
   * a sat page shows every cat riding that sat and where it sits now, whereas
   * the mint transaction shows only where a cat started and misleads once it
   * has moved.
   */
  catSat: number | null;
  /**
   * Rarest sat inside the UTXO's `sat_ranges`, when the scanner ran
   * the rare-sat check (small-UTXO gate — see `RARE_SAT_SCAN_MAX_VALUE_SAT`).
   * `null` when no rare sat was found OR when the check was skipped
   * for cost reasons (large UTXO, pathological range count).
   */
  rareSat: { sat: string; block: number; rarity: SatRarity } | null;
}


/**
 * Skip rare-sat detection when ord returns more than this many
 * `sat_ranges` tuples on a UTXO. Mixed / heavily-recycled UTXOs can
 * carry thousands — parsing them all would dominate the scanner's
 * per-UTXO cost budget. The bandwidth cost of receiving those tuples
 * is already sunk (ord doesn't let us opt out of `sat_ranges`), but
 * we can at least skip the parse.
 *
 * Below the cap: rarity math is O(1) per tuple, so bounded work.
 * Above the cap: `rareSat` on `UtxoContent` stays null; the picker
 * treats the UTXO as "rarity unchecked" rather than "clean".
 */
export const RARE_SAT_MAX_RANGES = 500;

/**
 * Per-UTXO scan state — drives the bucket-and-badge UI in both
 * frontends.
 *
 * - `not-scanned` — default for UTXOs above the auto-scan threshold.
 *   The picker shows a "Scan anyway" affordance.
 * - `scanning` — request in flight. Picker disables the row until
 *   the result lands.
 * - `scanned-clean` — both ord endpoints returned empty asset arrays.
 *   Picker marks the row safe; this is the auto-pick candidate.
 * - `scanned-with-assets` — at least one asset present. Picker shows
 *   what was found + links + an "Use anyway" override.
 * - `scan-failed` — at least one endpoint errored. Picker treats the
 *   row as "unknown safety" — neither auto-pick candidate nor blocked.
 */
export type UtxoScanState =
  | { kind: 'not-scanned' }
  | { kind: 'scanning' }
  | { kind: 'scanned-clean' }
  | { kind: 'scanned-with-assets'; content: UtxoContent }
  | { kind: 'scan-failed'; message: string };

/**
 * Helper for templates — true iff the state name describes a completed
 * scan (clean, with-assets, or failed). Lets the UI distinguish "we
 * haven't tried" from "we tried and got an answer".
 */
export function isScanComplete(s: UtxoScanState): boolean {
  return s.kind === 'scanned-clean' || s.kind === 'scanned-with-assets' || s.kind === 'scan-failed';
}

/**
 * Picker-display bucket the mint-flow UI bands UTXOs on. Maps 1:1 from
 * UtxoScanState but as a flat name the template can `@switch` on. Both
 * consumers (ordpool /cat21-mint and cat21.space /dashboard/mint) bind
 * the same five values; the SDK owns the type so they can't drift.
 */
export type UtxoScanBucket = 'clean' | 'unscanned' | 'assets' | 'scanning' | 'failed';

/**
 * Map a UtxoScanState to its display bucket. Drives badge labels,
 * row-button copy, and the auto-pick priority order.
 */
export function bucketOf(state: UtxoScanState): UtxoScanBucket {
  switch (state.kind) {
    case 'not-scanned': return 'unscanned';
    case 'scanning': return 'scanning';
    case 'scanned-clean': return 'clean';
    case 'scanned-with-assets': return 'assets';
    case 'scan-failed': return 'failed';
  }
}

/**
 * Auto-pick the largest "safe-enough" row from a bucket-annotated list.
 * Priority: scanned-clean (verified safe) → unscanned (probably-safe big
 * UTXO) → scan-failed (unknown, better than nothing). NEVER auto-pick
 * scanned-with-assets — that row requires an explicit "Use anyway"
 * click from the user.
 *
 * Callers pass any row shape that carries a `bucket` field; this
 * preserves the row type so consumers can use whatever shape they
 * stored (UtxoSimulation, ViableUtxoRow, etc.).
 */
export function findAutoPickCandidate<T extends { bucket: UtxoScanBucket }>(rows: T[]): T | null {
  return rows.find((r) => r.bucket === 'clean')
    ?? rows.find((r) => r.bucket === 'unscanned')
    ?? rows.find((r) => r.bucket === 'failed')
    ?? null;
}

/**
 * Names of every rune balance present on a scanned UTXO. `null` runes
 * (cat21-ord) or empty object short-circuits to an empty array. Used
 * by the asset-found UI to render one link per rune.
 */
export function runeNamesFromContent(content: UtxoContent): string[] {
  return content.runes ? Object.keys(content.runes) : [];
}

/**
 * UTXOs at or below this value on a single-address wallet are flagged
 * as potentially holding an ordinal-bound asset (inscription, rune,
 * rare sat, CAT-21 cat). 10k sat is the de-facto industry cut-off:
 * most ordinal-bearing UTXOs are 546 sat (the dust limit) or slightly
 * above; almost none exceed 10k. Content-safety heuristics, not fee
 * math.
 */
export const SMALL_UTXO_WARNING_THRESHOLD_SAT = 10_000;

