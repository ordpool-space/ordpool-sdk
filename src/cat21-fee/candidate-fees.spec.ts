import { resolveCandidateFees, outpointKey } from './candidate-fees.js';

/**
 * A funding model with the two shapes every cat tx has: WITH a change output
 * (larger) and WITHOUT one (smaller, leftover absorbed into the fee). The
 * absorb is what makes the realised fee differ between coins, so the model
 * has to carry it or the test cannot see the property it exists to pin.
 */
const FIXED_OUTPUTS = 546;
const DUST_FLOOR = 546;
const WITH_CHANGE_VSIZE = 150;
const NO_CHANGE_VSIZE = 110;

function simulate(candidate: { value: number }, feeSats: number) {
  const leftover = candidate.value - FIXED_OUTPUTS - feeSats;
  return leftover >= DUST_FLOOR
    ? { vsize: WITH_CHANGE_VSIZE, finalFeeSats: feeSats }
    : { vsize: NO_CHANGE_VSIZE, finalFeeSats: feeSats + leftover };
}

const utxo = (value: number, vout = 0) => ({ txid: 'a'.repeat(64), vout, value });

function feesFor(values: number[]) {
  return resolveCandidateFees(
    values.map((v, i) => utxo(v, i)),
    {
      simulate,
      feeBudgetFor: (c) => c.value - FIXED_OUTPUTS,
      feeRatePerVbyte: 1,
    },
  );
}

describe('resolveCandidateFees', () => {
  it('charges each coin its own realised fee, not one figure for the pool', () => {
    // 100000 and 1200 both cover the spend, and they cost DIFFERENT amounts:
    // the roomy coin pays the with-change fee, the dust-cliff coin hands its
    // whole remaining budget to the miner because the change would be sub-dust.
    const [roomy, cliff] = feesFor([100_000, 1_200]);

    expect(roomy.finalFeeSats).toBe(WITH_CHANGE_VSIZE);
    expect(cliff.finalFeeSats).toBe(1_200 - FIXED_OUTPUTS);
    expect(cliff.finalFeeSats).toBeGreaterThan(roomy.finalFeeSats as number);
  });

  it('prices a no-change coin at its whole budget', () => {
    // 700 leaves 154 sats of budget: too little for a change output, enough to
    // clear the no-change size at 1 sat/vB. The fee is the whole 154.
    const [tight] = feesFor([700]);
    expect(tight.finalFeeSats).toBe(154);
    expect(tight.vsize).toBe(NO_CHANGE_VSIZE);
  });

  it('reports a coin that cannot meet the rate as unfundable, not as free', () => {
    // 600 leaves 54 sats against a 110 vB floor: no fee clears the rate.
    const [tooSmall] = feesFor([600]);
    expect(tooSmall.finalFeeSats).toBeNull();
    expect(tooSmall.vsize).toBeNull();
  });

  it('keeps the outpoint so a picker can key rows against the recommendation', () => {
    const rows = feesFor([100_000, 1_200]);
    expect(rows.map((r) => outpointKey(r))).toEqual([`${'a'.repeat(64)}:0`, `${'a'.repeat(64)}:1`]);
  });

  it('sizes the budget per coin, so a rich neighbour cannot make a poor coin look fundable', () => {
    // 600 sats cannot meet the rate on its own budget, and its verdict must not
    // change because a 100 000-sat coin sits beside it in the same pool. This is
    // the case that separates a per-candidate budget from a shared one: with the
    // pool's largest budget applied to every row, the 600-sat coin is accepted
    // and priced at 54 sats instead of being reported unfundable.
    const [rich, poor] = feesFor([100_000, 600]);
    expect(rich.finalFeeSats).toBe(WITH_CHANGE_VSIZE);
    expect(poor.finalFeeSats).toBeNull();
  });
});
