/**
 * Asset-detection types for the mint flow's UTXO scanner. We query
 * BOTH our ord-proxy (`ord.ordpool.space`, returns regular inscriptions
 * + runes) AND our cat21-ord (`ord.cat21.space`, returns CAT-21 cats)
 * per outpoint, merging the answers into one `UtxoContent`.
 *
 * The detection is content-safety, not fee-math: an inscription at the
 * dust limit (546 sat) reads as "tiny UTXO" to the picker but carries
 * arbitrary off-chain value. On single-address wallets, spending such
 * a UTXO as a mint input sends the asset to the miner as fee.
 */

/**
 * Raw `/output/{outpoint}` shape returned by ord-proxy (and any real
 * ord with `--enable-json-api`). The subset we read here; ord ships
 * more fields (address, sat_ranges, script_pubkey, etc.) that we
 * ignore.
 */
export interface OrdOutputResponse {
  inscriptions?: string[];
  runes?: { [runeName: string]: unknown } | null;
}

/**
 * Same shape from cat21-ord. The fork swaps the `inscriptions` field
 * for `cats` because `--index-cat21` only indexes CAT-21 fake-
 * inscriptions and explicitly excludes everything else. Runes are
 * never indexed by cat21-ord, so the field is always `null` there.
 */
export interface Cat21OrdOutputResponse {
  cats?: string[];
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
}

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
