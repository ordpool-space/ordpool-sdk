import { describe, expect, it } from 'vitest';

import { AgentPolicyService } from './agent-policy.service';
import type { AgentActionContext, AgentPolicy } from './agent-policy.types';

const baseService = new AgentPolicyService();

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

describe(AgentPolicyService.name, () => {
  it('denies when agent is disabled', () => {
    const decision = baseService.evaluate({ ...basePolicy, enabled: false }, baseAction);
    expect(decision).toEqual({ allowed: false, reason: 'agent-disabled' });
  });

  it('denies action spending more than the per-action cap', () => {
    const decision = baseService.evaluate(basePolicy, {
      ...baseAction,
      spendSats: basePolicy.maxSpendPerActionSats + 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('spend-above-action-cap');
  });

  it('denies when daily cap would be exceeded by this action', () => {
    const decision = baseService.evaluate(basePolicy, {
      ...baseAction,
      spentTodaySats: basePolicy.dailyCapSats - 1_000,
      spendSats: 2_000,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('spend-above-daily-cap');
  });

  it('denies fee rate above the ceiling', () => {
    const decision = baseService.evaluate(basePolicy, {
      ...baseAction,
      feeRateSatPerVbyte: basePolicy.maxFeeRateSatPerVbyte + 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('fee-rate-above-ceiling');
  });

  it('denies sell-accept below floor price', () => {
    const decision = baseService.evaluate(basePolicy, {
      ...baseAction,
      kind: 'sell-accept',
      receivePriceSats: basePolicy.floorPriceSatsPerCat - 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('price-below-floor');
  });

  it('allows sell-accept at exactly floor price', () => {
    const decision = baseService.evaluate(basePolicy, {
      ...baseAction,
      kind: 'sell-accept',
      receivePriceSats: basePolicy.floorPriceSatsPerCat,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('denies counterparty not on allowlist when allowlist is non-empty', () => {
    const decision = baseService.evaluate(
      { ...basePolicy, allowedCounterparties: ['bc1qknownseller'] },
      { ...baseAction, kind: 'buy', counterpartyAddress: 'bc1qstranger' }
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('counterparty-not-allowed');
  });

  it('allows counterparty present on the allowlist', () => {
    const decision = baseService.evaluate(
      { ...basePolicy, allowedCounterparties: ['bc1qknownbuyer'] },
      { ...baseAction, kind: 'buy', counterpartyAddress: 'bc1qknownbuyer' }
    );
    expect(decision).toEqual({ allowed: true });
  });

  it('allows when allowlist is empty (no counterparty restriction)', () => {
    const decision = baseService.evaluate(basePolicy, {
      ...baseAction,
      counterpartyAddress: 'bc1qanyone',
    });
    expect(decision).toEqual({ allowed: true });
  });
});
