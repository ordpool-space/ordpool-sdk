import { describe, expect, it } from '@jest/globals';

import { calculateRecommendedFundingSats } from './recommended-funding.helper';

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
