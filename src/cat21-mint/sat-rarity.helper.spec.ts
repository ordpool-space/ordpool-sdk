import {
  findRareSatInRange,
  findRareSatInRanges,
  locateSat,
  rarityOfBlockFirstSat,
  rarityOfSat,
} from './sat-rarity.helper';

// Well-known first-sats-of-block for verification:
// - block 0        → sat 0                 → mythic
// - block 1        → sat 5_000_000_000     → uncommon
// - block 2016     → sat 10_080_000_000_000 → rare (first difficulty adjustment)
// - block 210_000  → sat 1_050_000_000_000_000 → epic (first halving)
// - block 1_260_000 → sat ...                → legendary (first cycle after epoch 0)

const FIRST_SAT_OF_BLOCK_1 = 5_000_000_000n;
const FIRST_SAT_OF_BLOCK_2 = 10_000_000_000n;
const FIRST_SAT_OF_BLOCK_2016 = 5_000_000_000n * 2016n;
const FIRST_SAT_OF_BLOCK_210000 = 5_000_000_000n * 210_000n;

describe('sat rarity math', () => {
  describe('rarityOfBlockFirstSat', () => {
    it('classifies known blocks', () => {
      expect(rarityOfBlockFirstSat(0)).toBe('mythic');
      expect(rarityOfBlockFirstSat(1)).toBe('uncommon');
      expect(rarityOfBlockFirstSat(2015)).toBe('uncommon');
      expect(rarityOfBlockFirstSat(2016)).toBe('rare');
      expect(rarityOfBlockFirstSat(209_999)).toBe('uncommon');
      expect(rarityOfBlockFirstSat(210_000)).toBe('epic');
      expect(rarityOfBlockFirstSat(1_260_000)).toBe('legendary');
    });
  });

  describe('locateSat', () => {
    it('places sat 0 in block 0', () => {
      const { block, firstSatOfBlock } = locateSat(0n);
      expect(block).toBe(0);
      expect(firstSatOfBlock).toBe(0n);
    });

    it('places the last sat of block 0 in block 0', () => {
      const { block } = locateSat(FIRST_SAT_OF_BLOCK_1 - 1n);
      expect(block).toBe(0);
    });

    it('places the first sat of block 1 in block 1', () => {
      const { block, firstSatOfBlock } = locateSat(FIRST_SAT_OF_BLOCK_1);
      expect(block).toBe(1);
      expect(firstSatOfBlock).toBe(FIRST_SAT_OF_BLOCK_1);
    });

    it('places sats deep in the middle of block 210_000 (first halving)', () => {
      const { block, subsidy } = locateSat(FIRST_SAT_OF_BLOCK_210000 + 1_000n);
      expect(block).toBe(210_000);
      // Post-halving subsidy: 25 BTC = 2_500_000_000 sats
      expect(subsidy).toBe(2_500_000_000n);
    });
  });

  describe('rarityOfSat', () => {
    it('marks sat 0 as mythic', () => {
      expect(rarityOfSat(0n)).toBe('mythic');
    });

    it('marks non-first-sats-of-block as common', () => {
      expect(rarityOfSat(1n)).toBe('common');
      expect(rarityOfSat(FIRST_SAT_OF_BLOCK_1 - 1n)).toBe('common');
      expect(rarityOfSat(FIRST_SAT_OF_BLOCK_1 + 1n)).toBe('common');
    });

    it('marks first sat of block 1 as uncommon', () => {
      expect(rarityOfSat(FIRST_SAT_OF_BLOCK_1)).toBe('uncommon');
    });

    it('marks first sat of block 2016 as rare (first difficulty adjustment)', () => {
      expect(rarityOfSat(FIRST_SAT_OF_BLOCK_2016)).toBe('rare');
    });

    it('marks first sat of block 210_000 as epic (first halving)', () => {
      expect(rarityOfSat(FIRST_SAT_OF_BLOCK_210000)).toBe('epic');
    });
  });

  describe('findRareSatInRange', () => {
    it('returns null for a common range within block 500', () => {
      // Block 500's first sat = 5_000_000_000 * 500 = 2_500_000_000_000.
      // A 546-sat postage range fully inside block 500 is all-common.
      const start = 2_500_000_000_000n + 100n;
      const end = start + 546n;
      expect(findRareSatInRange(start, end)).toBeNull();
    });

    it('finds the mythic sat when range starts at 0', () => {
      const hit = findRareSatInRange(0n, 546n);
      expect(hit).toEqual({ sat: 0n, block: 0, rarity: 'mythic' });
    });

    it('finds an uncommon sat when the range starts at block 1', () => {
      const hit = findRareSatInRange(FIRST_SAT_OF_BLOCK_1, FIRST_SAT_OF_BLOCK_1 + 546n);
      expect(hit).toEqual({ sat: FIRST_SAT_OF_BLOCK_1, block: 1, rarity: 'uncommon' });
    });

    it('finds the uncommon sat when a wide range crosses a mid-block boundary', () => {
      // Start just before first sat of block 2, end just past.
      const start = FIRST_SAT_OF_BLOCK_2 - 100n;
      const end = FIRST_SAT_OF_BLOCK_2 + 100n;
      const hit = findRareSatInRange(start, end);
      expect(hit).toEqual({ sat: FIRST_SAT_OF_BLOCK_2, block: 2, rarity: 'uncommon' });
    });

    it('returns the highest-rarity sat when a range spans many blocks', () => {
      // Range that covers block 2015 → block 2017 crosses first sat of block 2016 (rare).
      const start = FIRST_SAT_OF_BLOCK_2016 - 5_000_000_000n; // in block 2015
      const end = FIRST_SAT_OF_BLOCK_2016 + 5_000_000_000n; // into block 2016
      const hit = findRareSatInRange(start, end);
      expect(hit?.rarity).toBe('rare');
      expect(hit?.block).toBe(2016);
    });
  });

  describe('findRareSatInRanges', () => {
    it('returns null when every range is common', () => {
      const ranges: [bigint, bigint][] = [
        [1_000n, 1_546n],
        [100_000n, 100_546n],
      ];
      expect(findRareSatInRanges(ranges)).toBeNull();
    });

    it('picks the highest rarity across ranges', () => {
      const ranges: [bigint, bigint][] = [
        // Common range
        [500n, 546n],
        // Range starting at the mythic sat
        [0n, 100n],
        // Range starting at an uncommon
        [FIRST_SAT_OF_BLOCK_1, FIRST_SAT_OF_BLOCK_1 + 10n],
      ];
      const hit = findRareSatInRanges(ranges);
      expect(hit?.rarity).toBe('mythic');
    });
  });
});
