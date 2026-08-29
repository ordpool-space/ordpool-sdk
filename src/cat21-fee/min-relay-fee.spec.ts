import { describe, expect, it } from '@jest/globals';

import {
  BITCOIN_MIN_RELAY_FEE_SAT_PER_KVB,
  BITCOIN_MIN_RELAY_FEE_SAT_PER_VBYTE,
} from './min-relay-fee';

describe('Bitcoin min-relay-fee constant', () => {
  it('matches Bitcoin Core DEFAULT_MIN_RELAY_TX_FEE as of v29.1 (100 sat/kvB)', () => {
    // Verified against src/policy/policy.h: v29.0 = 1000, v29.1 = 100.
    expect(BITCOIN_MIN_RELAY_FEE_SAT_PER_KVB).toBe(100);
  });

  it('derives 0.1 sat/vByte (100 / 1000)', () => {
    expect(BITCOIN_MIN_RELAY_FEE_SAT_PER_VBYTE).toBe(0.1);
  });
});
