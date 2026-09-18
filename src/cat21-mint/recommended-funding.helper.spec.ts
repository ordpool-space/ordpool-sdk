import { describe, expect, it } from '@jest/globals';

import { calculateRecommendedFundingSats, calculateRecommendedPreferredSats } from './recommended-funding.helper.js';

describe('calculateRecommendedFundingSats', () => {
  it('is just the 546 postage (rounded up to 600) at a zero fee rate', () => {
    expect(calculateRecommendedFundingSats(0)).toBe(600);
  });

  it('scales monotonically with the fee rate', () => {
    expect(calculateRecommendedFundingSats(1)).toBeLessThan(calculateRecommendedFundingSats(5));
    expect(calculateRecommendedFundingSats(5)).toBeLessThan(calculateRecommendedFundingSats(100));
  });

  it('uses the REAL simulated mint vsize (~150-170 vB), well below the old 200-vB guess', () => {
    // f(r) = ceil((546 + vsize*r)/100)*100. At r=100 the postage is negligible,
    // so the result reveals the measured vsize.
    const at100 = calculateRecommendedFundingSats(100);
    const impliedVsize = (at100 - 546) / 100; // ~ the measured vsize (pre-round)

    expect(impliedVsize).toBeGreaterThan(140); // a real 1-in/2-out taproot mint
    expect(impliedVsize).toBeLessThan(190);

    // The old hardcoded 200-vB guess produced 20_600 at r=100; the simulated
    // vsize must produce a strictly smaller (more honest) floor.
    expect(at100).toBeLessThan(20_600);
  });
});

describe('calculateRecommendedPreferredSats — the change-headroom floor', () => {
  it('sits strictly above the feasibility floor, by at least the change dust limit', () => {
    for (const rate of [1, 5, 20]) {
      const feasible = calculateRecommendedFundingSats(rate);
      const preferred = calculateRecommendedPreferredSats(rate);
      expect(preferred).toBeGreaterThan(feasible);
      // The gap is what a change output needs to exist at all. Collapse it and
      // a caller sizing against the lower number picks coins selection skips.
      expect(preferred - feasible).toBeGreaterThanOrEqual(500);
    }
  });

  it('grows with the fee rate, because the with-change fee does', () => {
    expect(calculateRecommendedPreferredSats(20)).toBeGreaterThan(calculateRecommendedPreferredSats(1));
  });

  it('is a whole number of hundreds, like its sibling', () => {
    for (const rate of [1, 3, 7]) {
      expect(calculateRecommendedPreferredSats(rate) % 100).toBe(0);
    }
  });

  it('is deterministic across calls (the measured build is cached, not re-randomised)', () => {
    expect(calculateRecommendedPreferredSats(5)).toBe(calculateRecommendedPreferredSats(5));
  });
});
