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

const SUBSIDY_EPOCH_0 = 50n * 100_000_000n;
const BLOCKS_PER_HALVING = 210_000;
const DIFFICULTY_ADJUSTMENT_INTERVAL = 2016;
const BLOCKS_PER_CYCLE = 6 * BLOCKS_PER_HALVING; // 1_260_000

/** Rarity of the FIRST sat of a given block. Non-first sats are always `common`. */
export function rarityOfBlockFirstSat(block: number): SatRarity {
  if (block === 0) return 'mythic';
  if (block % BLOCKS_PER_CYCLE === 0) return 'legendary';
  if (block % BLOCKS_PER_HALVING === 0) return 'epic';
  if (block % DIFFICULTY_ADJUSTMENT_INTERVAL === 0) return 'rare';
  return 'uncommon';
}

/**
 * Given a sat number, return the block it was mined in AND the first
 * sat of that block. If `sat === firstSatOfBlock`, the sat is the
 * uncommon (or higher) block-first-sat; otherwise it's common.
 */
export function locateSat(sat: bigint): { block: number; firstSatOfBlock: bigint; subsidy: bigint } {
  if (sat < 0n) throw new Error(`sat must be non-negative; got ${sat}`);
  let epoch = 0;
  let cumStart = 0n;
  while (epoch < 33) {
    const subsidy = SUBSIDY_EPOCH_0 >> BigInt(epoch);
    if (subsidy === 0n) break;
    const epochSats = BigInt(BLOCKS_PER_HALVING) * subsidy;
    if (sat < cumStart + epochSats) {
      const blockInEpoch = Number((sat - cumStart) / subsidy);
      const block = epoch * BLOCKS_PER_HALVING + blockInEpoch;
      const firstSatOfBlock = cumStart + BigInt(blockInEpoch) * subsidy;
      return { block, firstSatOfBlock, subsidy };
    }
    cumStart += epochSats;
    epoch++;
  }
  throw new Error(`sat ${sat} is beyond the maximum supply`);
}

/** Rarity of an individual sat. */
export function rarityOfSat(sat: bigint): SatRarity {
  const { block, firstSatOfBlock } = locateSat(sat);
  if (sat === firstSatOfBlock) return rarityOfBlockFirstSat(block);
  return 'common';
}

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
export function findRareSatInRange(
  start: bigint,
  end: bigint,
): { sat: bigint; block: number; rarity: SatRarity } | null {
  if (end <= start) return null;

  const startInfo = locateSat(start);
  const endInfo = locateSat(end - 1n);

  // Block range that overlaps [start, end). The FIRST-sat of a block
  // is inside [start, end) iff (a) `start` equals it, OR (b) it belongs
  // to a block after `startInfo.block`.
  const startIsBlockFirstSat = start === startInfo.firstSatOfBlock;
  const firstBlockContributing = startIsBlockFirstSat ? startInfo.block : startInfo.block + 1;
  const lastBlockContributing = endInfo.block;

  if (firstBlockContributing > lastBlockContributing) return null;

  // Walk the rarity ladder top-down and short-circuit.
  const b1 = firstBlockContributing;
  const b2 = lastBlockContributing;

  if (b1 === 0) {
    return { sat: 0n, block: 0, rarity: 'mythic' };
  }
  const legendary = firstMultipleInRange(b1, b2, BLOCKS_PER_CYCLE);
  if (legendary !== null) {
    return { sat: firstSatOfBlock(legendary), block: legendary, rarity: 'legendary' };
  }
  const epic = firstMultipleInRange(b1, b2, BLOCKS_PER_HALVING);
  if (epic !== null) {
    return { sat: firstSatOfBlock(epic), block: epic, rarity: 'epic' };
  }
  const rare = firstMultipleInRange(b1, b2, DIFFICULTY_ADJUSTMENT_INTERVAL);
  if (rare !== null) {
    return { sat: firstSatOfBlock(rare), block: rare, rarity: 'rare' };
  }
  // Any remaining block first-sat is uncommon.
  return {
    sat: firstSatOfBlock(b1),
    block: b1,
    rarity: 'uncommon',
  };
}

/** Smallest multiple of `step` in `[low, high]` (inclusive), or null. */
function firstMultipleInRange(low: number, high: number, step: number): number | null {
  const m = Math.ceil(low / step) * step;
  return m <= high ? m : null;
}

/** First sat of a block, O(1) via epoch arithmetic. */
function firstSatOfBlock(block: number): bigint {
  const epoch = Math.floor(block / BLOCKS_PER_HALVING);
  // Sum of subsidies of every full prior epoch.
  let cum = 0n;
  for (let e = 0; e < epoch; e++) {
    const s = SUBSIDY_EPOCH_0 >> BigInt(e);
    cum += BigInt(BLOCKS_PER_HALVING) * s;
  }
  const subsidyThisEpoch = SUBSIDY_EPOCH_0 >> BigInt(epoch);
  const blockInEpoch = block - epoch * BLOCKS_PER_HALVING;
  return cum + BigInt(blockInEpoch) * subsidyThisEpoch;
}

/**
 * Highest-rarity sat across every `[start, end)` range on a UTXO,
 * as ord returns them on `/output/{outpoint}` (`sat_ranges`). Returns
 * null when every range is entirely common — the fast path.
 */
const RARITY_RANK: Record<SatRarity, number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5,
};

export function findRareSatInRanges(
  ranges: ReadonlyArray<readonly [bigint, bigint]>,
): { sat: bigint; block: number; rarity: SatRarity } | null {
  let rarest: { sat: bigint; block: number; rarity: SatRarity } | null = null;
  for (const [start, end] of ranges) {
    const hit = findRareSatInRange(start, end);
    if (hit && (rarest === null || RARITY_RANK[hit.rarity] > RARITY_RANK[rarest.rarity])) {
      rarest = hit;
      if (hit.rarity === 'mythic') return rarest;
    }
  }
  return rarest;
}
