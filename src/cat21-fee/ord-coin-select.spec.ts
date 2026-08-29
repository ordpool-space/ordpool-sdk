import { describe, expect, it } from '@jest/globals';

import {
  CardinalUtxoCandidate,
  estimateFeeSats,
  estimateTaprootVbytes,
  selectCardinalUtxo,
  selectOrdParityFunding,
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

describe('selectOrdParityFunding — ord build_transaction (ExactPostage) parity', () => {
  const P2TR = 34;

  it('self-funded (1M cat, target 66k, rate 17.3) matches ord build_transaction_with_custom_postage', () => {
    // ord's own vector: 1 input of 1_000_000, ExactPostage(66_000), fee_rate 17.3
    // -> outputs [66_000, 1_000_000 - 66_000 - fee]. fee = ceil(154 vB * 17.3).
    const r = selectOrdParityFunding({
      outgoingValueSats: 1_000_000,
      targetPostageSats: 66_000,
      feeRatePerVb: 17.3,
      cardinalUtxos: [],
      outgoingScriptLen: P2TR,
      changeScriptLen: P2TR,
      changeDustSats: 330,
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.fundingInputs).toEqual([]); // the cat self-funds; no cardinal added
    expect(r.outputSats).toBe(66_000);
    expect(r.feeSats).toBe(2_665); // ceil(154 * 17.3)
    expect(r.changeSats).toBe(1_000_000 - 66_000 - 2_665);
  });

  it('preserve-transfer (546 cat + one 50k cardinal, rate 1) picks the cardinal + ord fee', () => {
    const r = selectOrdParityFunding({
      outgoingValueSats: 546,
      targetPostageSats: 546,
      feeRatePerVb: 1,
      cardinalUtxos: [{ txid: 'aa'.repeat(32), vout: 0, value: 50_000 }],
      outgoingScriptLen: P2TR,
      changeScriptLen: P2TR,
      changeDustSats: 330,
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.fundingInputs.map((u) => u.value)).toEqual([50_000]);
    expect(r.outputSats).toBe(546);
    expect(r.feeSats).toBe(212); // 2-in / 2-out taproot at 1 sat/vB
    expect(r.changeSats).toBe(50_000 - 212);
  });

  it('errors NotEnoughCardinalUtxos when funding cannot cover target + fee', () => {
    const r = selectOrdParityFunding({
      outgoingValueSats: 546,
      targetPostageSats: 10_000,
      feeRatePerVb: 1,
      cardinalUtxos: [{ txid: 'aa'.repeat(32), vout: 0, value: 100 }],
      outgoingScriptLen: P2TR,
      changeScriptLen: P2TR,
      changeDustSats: 330,
    });
    expect('error' in r).toBe(true);
  });
});
