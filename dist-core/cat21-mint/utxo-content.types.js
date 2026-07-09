"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SMALL_UTXO_WARNING_THRESHOLD_SAT = exports.RARE_SAT_MAX_RANGES = void 0;
exports.isScanComplete = isScanComplete;
exports.bucketOf = bucketOf;
exports.findAutoPickCandidate = findAutoPickCandidate;
exports.runeNamesFromContent = runeNamesFromContent;
exports.calculateRecommendedFundingSats = calculateRecommendedFundingSats;
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
exports.RARE_SAT_MAX_RANGES = 500;
/**
 * Helper for templates — true iff the state name describes a completed
 * scan (clean, with-assets, or failed). Lets the UI distinguish "we
 * haven't tried" from "we tried and got an answer".
 */
function isScanComplete(s) {
    return s.kind === 'scanned-clean' || s.kind === 'scanned-with-assets' || s.kind === 'scan-failed';
}
/**
 * Map a UtxoScanState to its display bucket. Drives badge labels,
 * row-button copy, and the auto-pick priority order.
 */
function bucketOf(state) {
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
function findAutoPickCandidate(rows) {
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
function runeNamesFromContent(content) {
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
exports.SMALL_UTXO_WARNING_THRESHOLD_SAT = 10_000;
/**
 * Funding floor in sats for the empty-state hint in the mint flow.
 * Derived from the user's currently-picked fee rate using a
 * conservative ~200 vB reference vsize (real CAT-21 mints are
 * ~150–170 vB depending on wallet type), rounded up to the next 100
 * sat so the displayed number reads cleanly. At 1 sat/vB that's
 * ~800 sat; at 5 sat/vB ~1600; at 100 sat/vB ~20,600.
 *
 * The SDK's actual viable-UTXO check is dynamic per-PSBT; this helper
 * just stops the user-facing hint from quoting launch-era numbers
 * (10k or 200k sat) when current mainnet fees are much lower.
 */
function calculateRecommendedFundingSats(feeRatePerVb) {
    return Math.ceil((546 + 200 * feeRatePerVb) / 100) * 100;
}
//# sourceMappingURL=utxo-content.types.js.map