import { describe, expect, it } from '@jest/globals';

import { findSatOffset } from './sat-offset';

describe('findSatOffset', () => {
  // Two ranges, as an output assembled from two inputs reports them.
  const ranges: Array<[number, number]> = [[1_000, 1_500], [9_000, 9_100]];

  it('counts the offset across ranges in output order', () => {
    expect(findSatOffset(ranges, 1_000)).toBe(0);
    expect(findSatOffset(ranges, 1_499)).toBe(499);
    expect(findSatOffset(ranges, 9_000)).toBe(500);
    expect(findSatOffset(ranges, 9_099)).toBe(599);
  });

  it('range ends are exclusive, and a sat outside every range is not found', () => {
    expect(findSatOffset(ranges, 1_500)).toBeUndefined();
    expect(findSatOffset(ranges, 9_100)).toBeUndefined();
    expect(findSatOffset(ranges, 5)).toBeUndefined();
  });

  it('rejects a sat that is not a non-negative safe integer', () => {
    expect(() => findSatOffset(ranges, -1)).toThrow('non-negative safe integer');
    expect(() => findSatOffset(ranges, 1.5)).toThrow('non-negative safe integer');
  });
});
