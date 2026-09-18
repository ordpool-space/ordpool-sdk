import { describe, expect, it } from '@jest/globals';

import { recommendedFeesFixture } from './recommended-fees.fixtures.js';

describe('recommendedFeesFixture', () => {
  it('carries every tier the RecommendedFees contract declares', () => {
    // Pinned as a literal rather than derived from the type, so adding a tier
    // to the contract without adding it here reds this spec instead of
    // silently shipping consumers a body the server no longer sends.
    expect(Object.keys(recommendedFeesFixture()).sort()).toEqual([
      'economyFee', 'fastestFee', 'halfHourFee', 'hourFee', 'minimumFee',
    ]);
  });

  it('reproduces the captured response exactly', () => {
    expect(recommendedFeesFixture()).toEqual({
      fastestFee: 2, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1,
    });
  });

  it('lets a spec state a distinguishable spread at its own call site', () => {
    const spread = recommendedFeesFixture({ fastestFee: 40, halfHourFee: 20, hourFee: 10 });
    expect(spread.fastestFee).toBe(40);
    expect(spread.hourFee).toBe(10);
    // Untouched tiers still come from the captured sample.
    expect(spread.minimumFee).toBe(1);
  });
});
