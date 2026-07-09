/**
 * Ordinal-theory sat rarity math. Pure functions, no I/O — every
 * classification is derived from the sat number alone.
 *
 * Categories (highest rarity wins when multiple apply):
 *   - `mythic`     — sat 0 (the very first sat of Bitcoin, block 0).
 *   - `legendary`  — first sat of a cycle (every 6 halvings = 1_260_000 blocks).
 *   - `epic`       — first sat of a halving block (every 210_000 blocks).
 *   - `rare`       — first sat of a difficulty adjustment block (every 2016 blocks).
 *   - `uncommon`   — first sat of any other block.
 *   - `common`     — every non-first sat.
 *
 * Halving epochs shrink block subsidy by half every 210_000 blocks:
 *   e=0 (blocks 0..209_999):        50 BTC =           5_000_000_000 sat
 *   e=1 (blocks 210k..419_999):     25 BTC =           2_500_000_000 sat
 *   e=2 (blocks 420k..629_999):     12.5 BTC =         1_250_000_000 sat
 *   e=3 (blocks 630k..839_999):     6.25 BTC =           625_000_000 sat
 *   ...
 *   e=32 approximately mines the last sat; subsidy becomes 0 sat at e=33.
 *
 * We use bigint throughout because the total sat supply (~21e14 sats)
 * exceeds `Number.MAX_SAFE_INTEGER` (~9e15 fits, but midway math needs
 * safety) and range-endpoint math is easier without precision loss.
 */
export type SatRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';
/** Rarity of the FIRST sat of a given block. Non-first sats are always `common`. */
export declare function rarityOfBlockFirstSat(block: number): SatRarity;
/**
 * Given a sat number, return the block it was mined in AND the first
 * sat of that block. If `sat === firstSatOfBlock`, the sat is the
 * uncommon (or higher) block-first-sat; otherwise it's common.
 */
export declare function locateSat(sat: bigint): {
    block: number;
    firstSatOfBlock: bigint;
    subsidy: bigint;
};
/** Rarity of an individual sat. */
export declare function rarityOfSat(sat: bigint): SatRarity;
/**
 * Find the highest-rarity sat inside a half-open range `[start, end)`.
 *
 * O(1) in the range width: given the block containing `start` and the
 * block containing `end-1`, we ask "does this block interval contain
 * any multiple of X" for each rarity threshold (cycle, halving,
 * difficulty adjustment). The rarest positive answer wins. No
 * block-by-block iteration.
 *
 * That matters because `sat_ranges` returned by ord can span millions
 * of blocks for wide UTXO ranges; a walker would be prohibitive.
 */
export declare function findRareSatInRange(start: bigint, end: bigint): {
    sat: bigint;
    block: number;
    rarity: SatRarity;
} | null;
/**
 * Highest-rarity sat across every `[start, end)` range on a UTXO,
 * as ord returns them on `/output/{outpoint}` (`sat_ranges`). Returns
 * null when every range is entirely common — the fast path.
 */
export declare function findRareSatInRanges(ranges: ReadonlyArray<readonly [bigint, bigint]>): {
    sat: bigint;
    block: number;
    rarity: SatRarity;
} | null;
//# sourceMappingURL=sat-rarity.helper.d.ts.map