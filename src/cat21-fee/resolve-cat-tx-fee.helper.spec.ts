import { resolveCatTxFee, CatTxFeeSimulation } from './resolve-cat-tx-fee.helper';

// Guess-free fee resolution, verified against a model of the real builder's two
// topologies. A cat tx is either WITH a change output (vsize V_WC) or WITHOUT
// (leftover absorbed into the fee, vsize V_NC). The model mirrors
// buildCat21MintPsbt: change < dust is absorbed into finalFeeSats.

const POSTAGE = 546;
const DUST = 330; // taproot change floor
const V_WC = 154; // with-change vsize
const V_NC = 111; // no-change vsize

/** Model builder: `simulate(feeSats)` for a given coin value. Never called with feeSats > budget. */
function modelSimulate(coinValue: number) {
  return (feeSats: number): CatTxFeeSimulation => {
    const changeRaw = coinValue - POSTAGE - feeSats;
    if (changeRaw < 0) throw new Error('builder would reject: fee exceeds budget');
    if (changeRaw >= DUST) return { vsize: V_WC, finalFeeSats: feeSats };
    return { vsize: V_NC, finalFeeSats: feeSats + changeRaw }; // sub-dust absorbed
  };
}

const resolve = (coinValue: number, rate: number) =>
  resolveCatTxFee({ simulate: modelSimulate(coinValue), feeRatePerVbyte: rate, feeBudgetSats: coinValue - POSTAGE });

describe('resolveCatTxFee (guess-free, two-topology)', () => {
  it('large coin => with-change form at the exact measured fee', () => {
    const r = resolve(100_000, 10);
    expect(r).not.toBeNull();
    expect(r!.vsize).toBe(V_WC);
    expect(r!.finalFeeSats).toBe(V_WC * 10); // 1540, real change output
  });

  it('coin that comfortably fits a change output => with-change', () => {
    // budget leaves >= dust after the with-change fee.
    const r = resolve(POSTAGE + V_WC * 10 + DUST, 10); // 2416
    expect(r!.vsize).toBe(V_WC);
    expect(r!.finalFeeSats).toBe(V_WC * 10);
  });

  it('oscillation band: change would be sub-dust => no-change, surplus absorbed (mints, not rejected)', () => {
    // The exact coin the old fixed-200 ceiling wrongly rejected.
    const coin = POSTAGE + V_WC * 10 + 100; // 2186; leftover after 1540 fee = 100 < dust
    const r = resolve(coin, 10);
    expect(r).not.toBeNull();
    expect(r!.vsize).toBe(V_NC);
    expect(r!.finalFeeSats).toBe(coin - POSTAGE); // whole surplus absorbed = 1640
  });

  it('no-change-only coin (below the with-change threshold) still mints', () => {
    const coin = POSTAGE + V_NC * 10 + 50; // 1706; can't afford with-change (needs 2086)
    const r = resolve(coin, 10);
    expect(r).not.toBeNull();
    expect(r!.vsize).toBe(V_NC);
    expect(r!.finalFeeSats).toBe(coin - POSTAGE); // 1160
  });

  it('at the exact no-change rate floor => mints', () => {
    const coin = POSTAGE + V_NC * 10; // 1656; budget exactly V_NC*rate
    const r = resolve(coin, 10);
    expect(r).not.toBeNull();
    expect(r!.vsize).toBe(V_NC);
    expect(r!.finalFeeSats).toBe(V_NC * 10); // 1110
  });

  it('one sat under the no-change floor => insufficient (null, no false-mint)', () => {
    const coin = POSTAGE + V_NC * 10 - 1; // 1655
    expect(resolve(coin, 10)).toBeNull();
  });

  it('coin below postage => insufficient', () => {
    expect(resolve(POSTAGE - 1, 10)).toBeNull();
  });

  it('never over-estimates: no result exceeds the budget', () => {
    for (const coin of [1656, 1706, 2000, 2186, 2416, 10_000, 100_000]) {
      const r = resolve(coin, 10);
      if (r) expect(r.finalFeeSats).toBeLessThanOrEqual(coin - POSTAGE);
    }
  });

  it('rejects a non-positive fee rate', () => {
    expect(() => resolve(100_000, 0)).toThrow(/positive/);
    expect(() => resolve(100_000, -1)).toThrow(/positive/);
  });
});
