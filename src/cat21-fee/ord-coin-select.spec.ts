import { describe, expect, it } from '@jest/globals';

import {
  CardinalUtxoCandidate,
  estimateFeeSats,
  estimateTaprootVbytes,
  selectCardinalUtxo,
} from './ord-coin-select';

/**
 * ord's own fixture from `transaction_builder.rs`
 * `select_cardinal_utxo_prefer_under_helper`: seven UTXOs with these values,
 * keyed by ord's outpoint(N). Values are distinct so the outpoint order does
 * not affect the value-based pick — the vectors below are order-independent.
 */
const c = (n: number, value: number): CardinalUtxoCandidate => ({
  txid: n.toString(16).padStart(64, '0'),
  vout: 0,
  value,
});
const ORD_FIXTURE: CardinalUtxoCandidate[] = [
  c(4, 101),
  c(1, 20_000),
  c(2, 105),
  c(5, 103),
  c(6, 10_000),
  c(3, 104),
  c(7, 102),
];

describe('selectCardinalUtxo — byte-parity with ord select_cardinal_utxo', () => {
  // The six vectors asserted verbatim in ord's `select_cardinal_utxo_prefer_under`.
  it.each<[number, boolean, number]>([
    [104, true, 104], //     biggest utxo <= 104
    [1_000, true, 105], //   biggest utxo <= 1_000
    [10, true, 101], //      none <= 10, so smallest > 10
    [104, false, 104], //    smallest utxo >= 104
    [1_000, false, 10_000], // smallest utxo >= 1_000
    [100_000, false, 20_000], // none >= 100_000, so biggest < 100_000
  ])('target=%i preferUnder=%s selects value %i', (target, preferUnder, expected) => {
    expect(selectCardinalUtxo(ORD_FIXTURE, target, preferUnder)?.value).toBe(expected);
  });

  it('returns null on empty candidates (ord NotEnoughCardinalUtxos)', () => {
    expect(selectCardinalUtxo([], 1_000, false)).toBeNull();
  });

  it('with a single candidate the pick is FORCED regardless of target/preference', () => {
    // The maintainer's insight: two available inputs (cat + one funding) means
    // selection is forced, so our pick == ord's pick by definition.
    const only = [c(1, 777)];
    expect(selectCardinalUtxo(only, 10, false)?.value).toBe(777);
    expect(selectCardinalUtxo(only, 100_000, true)?.value).toBe(777);
  });
});

describe('estimateTaprootVbytes / estimateFeeSats — ord taproot fee model', () => {
  it('1-in / 1-out (P2TR) is the canonical ~111 vbytes', () => {
    expect(estimateTaprootVbytes(1, [34])).toBe(111);
  });

  it('1-in / 2-out (P2TR) is ~154 vbytes; each extra output adds 43 (ord ADDITIONAL_OUTPUT_VBYTES)', () => {
    expect(estimateTaprootVbytes(1, [34, 34])).toBe(154);
    expect(estimateTaprootVbytes(1, [34, 34]) - estimateTaprootVbytes(1, [34])).toBe(43);
  });

  it('each extra taproot input adds ~57-58 vbytes (ord ADDITIONAL_INPUT_VBYTES = 57)', () => {
    const delta = estimateTaprootVbytes(2, [34, 34]) - estimateTaprootVbytes(1, [34, 34]);
    expect(delta).toBeGreaterThanOrEqual(57);
    expect(delta).toBeLessThanOrEqual(58);
  });

  it('estimateFeeSats = ceil(vsize x feeRate)', () => {
    expect(estimateFeeSats(1, [34, 34], 10)).toBe(1_540); // 154 * 10
    expect(estimateFeeSats(1, [34], 1)).toBe(111);
    expect(estimateFeeSats(1, [34], 1.5)).toBe(Math.ceil(111 * 1.5)); // rounds up
  });
});
