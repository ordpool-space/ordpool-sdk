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
});
