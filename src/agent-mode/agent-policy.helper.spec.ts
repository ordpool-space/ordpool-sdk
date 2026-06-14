import { describe, expect, it } from '@jest/globals';

import { evaluateAgentPolicy } from './agent-policy.helper';
import { AgentActionContext, AgentPolicy } from './agent-policy.types';

const basePolicy: AgentPolicy = {
  enabled: true,
  maxSpendPerActionSats: 100_000,
  dailyCapSats: 500_000,
  maxFeeRateSatPerVbyte: 50,
  floorPriceSatsPerCat: 21_000,
  allowedCounterparties: [],
};

const baseAction: AgentActionContext = {
  kind: 'mint',
  spendSats: 5_000,
  feeRateSatPerVbyte: 10,
  spentTodaySats: 0,
};

describe('evaluateAgentPolicy', () => {

  it('denies when agent is disabled', () => {
    const decision = evaluateAgentPolicy({ ...basePolicy, enabled: false }, baseAction);
    expect(decision).toEqual({ allowed: false, reason: 'agent-disabled' });
  });

  it('allows a vanilla mint that passes every gate', () => {
    expect(evaluateAgentPolicy(basePolicy, baseAction)).toEqual({ allowed: true });
  });

  it('denies when spend exceeds the per-action cap', () => {
    const decision = evaluateAgentPolicy(basePolicy, {
      ...baseAction,
      spendSats: basePolicy.maxSpendPerActionSats + 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('spend-above-action-cap');
      expect(decision.detail).toBeDefined();
    }
  });

  it('allows spend at exactly the per-action cap (not above)', () => {
    expect(
      evaluateAgentPolicy(basePolicy, {
        ...baseAction,
        spendSats: basePolicy.maxSpendPerActionSats,
      })
    ).toEqual({ allowed: true });
  });

  it('denies when daily cap would be exceeded by this action', () => {
    const decision = evaluateAgentPolicy(basePolicy, {
      ...baseAction,
      spentTodaySats: basePolicy.dailyCapSats - 1_000,
      spendSats: 2_000,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('spend-above-daily-cap');
  });

  it('allows when daily-cap budget is exactly met (not exceeded)', () => {
    expect(
      evaluateAgentPolicy(basePolicy, {
        ...baseAction,
        spentTodaySats: basePolicy.dailyCapSats - baseAction.spendSats,
      })
    ).toEqual({ allowed: true });
  });

  it('denies fee rate above the ceiling', () => {
    const decision = evaluateAgentPolicy(basePolicy, {
      ...baseAction,
      feeRateSatPerVbyte: basePolicy.maxFeeRateSatPerVbyte + 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('fee-rate-above-ceiling');
  });

  it('denies sell-accept below floor price', () => {
    const decision = evaluateAgentPolicy(basePolicy, {
      ...baseAction,
      kind: 'sell-accept',
      receivePriceSats: basePolicy.floorPriceSatsPerCat - 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('price-below-floor');
  });

  it('allows sell-accept at exactly floor price', () => {
    expect(
      evaluateAgentPolicy(basePolicy, {
        ...baseAction,
        kind: 'sell-accept',
        receivePriceSats: basePolicy.floorPriceSatsPerCat,
      })
    ).toEqual({ allowed: true });
  });

  it('treats sell-accept without receivePriceSats as 0 (denies if floor > 0)', () => {
    const decision = evaluateAgentPolicy(basePolicy, {
      ...baseAction,
      kind: 'sell-accept',
      // receivePriceSats omitted
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('price-below-floor');
  });

  it('does NOT apply floor-price gate to mint or buy actions', () => {
    expect(
      evaluateAgentPolicy(basePolicy, { ...baseAction, kind: 'mint' })
    ).toEqual({ allowed: true });
    expect(
      evaluateAgentPolicy(basePolicy, {
        ...baseAction,
        kind: 'buy',
        counterpartyAddress: 'bc1qbuy',
      })
    ).toEqual({ allowed: true });
  });

  it('denies counterparty not on allowlist when allowlist is non-empty', () => {
    const decision = evaluateAgentPolicy(
      { ...basePolicy, allowedCounterparties: ['bc1qknownseller'] },
      { ...baseAction, kind: 'buy', counterpartyAddress: 'bc1qstranger' }
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('counterparty-not-allowed');
  });

  it('allows counterparty present on the allowlist', () => {
    expect(
      evaluateAgentPolicy(
        { ...basePolicy, allowedCounterparties: ['bc1qknownbuyer'] },
        { ...baseAction, kind: 'buy', counterpartyAddress: 'bc1qknownbuyer' }
      )
    ).toEqual({ allowed: true });
  });

  it('allows when allowlist is empty (no counterparty restriction)', () => {
    expect(
      evaluateAgentPolicy(basePolicy, {
        ...baseAction,
        counterpartyAddress: 'bc1qanyone',
      })
    ).toEqual({ allowed: true });
  });

  it('allows when allowlist is non-empty but counterpartyAddress is omitted', () => {
    // Edge case: caller didn't pass a counterparty. The action is allowed —
    // the gate fires only when both an allowlist exists AND a counterparty
    // address is offered for matching.
    expect(
      evaluateAgentPolicy(
        { ...basePolicy, allowedCounterparties: ['bc1qknown'] },
        baseAction
      )
    ).toEqual({ allowed: true });
  });

  describe('Finding #10 — deny ordering precedence (cheapest-first)', () => {

    it('returns the EARLIEST applicable deny reason when multiple gates would fail', () => {
      // enabled gate is the first one; both it and action-cap would trip.
      // agent-disabled must win.
      const decision = evaluateAgentPolicy(
        { ...basePolicy, enabled: false, maxSpendPerActionSats: 1 },
        { ...baseAction, spendSats: 1_000_000 }
      );
      expect(decision).toEqual({ allowed: false, reason: 'agent-disabled' });
    });

    it('action-cap deny precedes daily-cap deny when both would trip', () => {
      const decision = evaluateAgentPolicy(
        { ...basePolicy, maxSpendPerActionSats: 1, dailyCapSats: 1 },
        { ...baseAction, spendSats: 1_000_000, spentTodaySats: 0 }
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('spend-above-action-cap');
    });

    it('daily-cap deny precedes fee-rate deny when both would trip', () => {
      const decision = evaluateAgentPolicy(
        { ...basePolicy, dailyCapSats: 1, maxFeeRateSatPerVbyte: 1 },
        { ...baseAction, spendSats: 10, feeRateSatPerVbyte: 1_000_000 }
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('spend-above-daily-cap');
    });

    it('fee-rate deny precedes floor-price deny on a sell-accept that trips both', () => {
      const decision = evaluateAgentPolicy(
        { ...basePolicy, maxFeeRateSatPerVbyte: 1, floorPriceSatsPerCat: 1_000_000 },
        {
          ...baseAction,
          kind: 'sell-accept',
          feeRateSatPerVbyte: 100,
          receivePriceSats: 1,
        }
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('fee-rate-above-ceiling');
    });

    it('floor-price deny precedes counterparty deny on a sell-accept that trips both', () => {
      const decision = evaluateAgentPolicy(
        {
          ...basePolicy,
          floorPriceSatsPerCat: 1_000_000,
          allowedCounterparties: ['bc1qknownbuyer'],
        },
        {
          ...baseAction,
          kind: 'sell-accept',
          receivePriceSats: 1,
          counterpartyAddress: 'bc1qstranger',
        }
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('price-below-floor');
    });
  });

  describe('Finding #11 — counterpartyAddress: "" (empty string) edge case', () => {

    it('treats empty-string counterpartyAddress as a normal allowlist miss when allowlist is non-empty', () => {
      const decision = evaluateAgentPolicy(
        { ...basePolicy, allowedCounterparties: ['bc1qknown'] },
        { ...baseAction, kind: 'buy', counterpartyAddress: '' }
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('counterparty-not-allowed');
    });
  });

  describe('Finding #12 — sell-accept + counterparty allowlist combined', () => {

    it('on sell-accept, denies a price-above-floor offer from an unknown buyer', () => {
      const decision = evaluateAgentPolicy(
        { ...basePolicy, allowedCounterparties: ['bc1qknownbuyer'] },
        {
          ...baseAction,
          kind: 'sell-accept',
          receivePriceSats: basePolicy.floorPriceSatsPerCat + 1_000,
          counterpartyAddress: 'bc1qstranger',
        }
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('counterparty-not-allowed');
    });

    it('on sell-accept, allows a price-above-floor offer from a known buyer', () => {
      expect(
        evaluateAgentPolicy(
          { ...basePolicy, allowedCounterparties: ['bc1qknownbuyer'] },
          {
            ...baseAction,
            kind: 'sell-accept',
            receivePriceSats: basePolicy.floorPriceSatsPerCat + 1_000,
            counterpartyAddress: 'bc1qknownbuyer',
          }
        )
      ).toEqual({ allowed: true });
    });
  });
});
