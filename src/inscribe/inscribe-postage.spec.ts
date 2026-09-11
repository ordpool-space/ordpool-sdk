import { describe, expect, it } from '@jest/globals';

import { INSCRIBE_POSTAGE_SATS, resolveInscribePostage } from './inscription-commit.helper';

/**
 * Parity with `ord wallet inscribe --postage` is proven on regtest at four
 * sizes in e2e/regtest/inscribe-postage-parity.spec.ts. These cover what ord
 * cannot be made to produce.
 */
describe('resolveInscribePostage', () => {
  it('defaults to 546 when the caller does not choose, which is cheaper than ord\'s 10000', () => {
    expect(resolveInscribePostage(undefined)).toBe(546);
    expect(INSCRIBE_POSTAGE_SATS).toBe(546);
  });

  it('returns the caller\'s choice unchanged', () => {
    expect(resolveInscribePostage(10_000)).toBe(10_000);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects %p rather than building a broken output', (bad) => {
    expect(() => resolveInscribePostage(bad)).toThrow(/positive integer/);
  });
});

describe('MAX_STANDARD_TX_WEIGHT', () => {
  it('is the Core relay limit of 400000, allowed exactly, refused one over, unless noLimit', async () => {
    const { MAX_STANDARD_TX_WEIGHT, assertRevealWithinStandardWeight } = await import('./inscription-reveal.helper');
    expect(MAX_STANDARD_TX_WEIGHT).toBe(400_000);
    expect(() => assertRevealWithinStandardWeight(400_000, false)).not.toThrow();
    expect(() => assertRevealWithinStandardWeight(400_001, false))
      .toThrow('reveal transaction weight greater than 400000 (MAX_STANDARD_TX_WEIGHT): 400001');
    expect(() => assertRevealWithinStandardWeight(400_001, true)).not.toThrow();
  });
});
