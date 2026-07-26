import { describe, expect, it } from '@jest/globals';

import { evaluateAgentPolicy } from './agent-policy.helper';
import { AgentActionContext, AgentActionKind, AgentPolicy } from './agent-policy.types';

const basePolicy: AgentPolicy = {
  enabled: true,
  maxSpendPerActionSats: 100_000,
  dailyCapSats: 500_000,
  maxFeeRateSatPerVbyte: 50,
  floorPriceSatsPerCat: 21_000,
  allowedCounterparties: [],
};

const baseAction: AgentActionContext = {
  kind: 'cat21_mint',
  spendSats: 5_000,
  feeRateSatPerVbyte: 10,
  spentTodaySats: 0,
};

describe('AgentActionKind — wallet RPC method names verbatim', () => {

  // Pinning the four exact strings the wallet emits over chrome.runtime /
  // NMH. If the wallet renames a method or the SDK drifts, this test goes
  // red before the dispatcher silently mis-routes a real action.
  it('accepts the four cat21_* method names', () => {
    const validKinds: AgentActionKind[] = [
      'cat21_mint',
      'cat21_transfer',
      'cat21_create_offer',
      'cat21_accept_offer',
    ];
    for (const kind of validKinds) {
      const decision = evaluateAgentPolicy(basePolicy, {
        ...baseAction,
        kind,
        // accept-offer needs a price >= floor to pass; the others ignore it
        receivePriceSats: basePolicy.floorPriceSatsPerCat,
      });
      expect(decision).toEqual({ allowed: true });
    }
  });
});

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

  it('denies cat21_accept_offer below floor price', () => {
    const decision = evaluateAgentPolicy(basePolicy, {
      ...baseAction,
      kind: 'cat21_accept_offer',
      receivePriceSats: basePolicy.floorPriceSatsPerCat - 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('price-below-floor');
  });

  it('allows cat21_accept_offer at exactly floor price', () => {
    expect(
      evaluateAgentPolicy(basePolicy, {
        ...baseAction,
        kind: 'cat21_accept_offer',
        receivePriceSats: basePolicy.floorPriceSatsPerCat,
      })
    ).toEqual({ allowed: true });
  });

  it('treats cat21_accept_offer without receivePriceSats as 0 (denies if floor > 0)', () => {
    const decision = evaluateAgentPolicy(basePolicy, {
      ...baseAction,
      kind: 'cat21_accept_offer',
      // receivePriceSats omitted
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('price-below-floor');
  });

  it('does NOT apply floor-price gate to non-accept-offer actions', () => {
    expect(
      evaluateAgentPolicy(basePolicy, { ...baseAction, kind: 'cat21_mint' })
    ).toEqual({ allowed: true });
    expect(
      evaluateAgentPolicy(basePolicy, {
        ...baseAction,
        kind: 'cat21_transfer',
        counterpartyAddress: 'bc1qbuy',
      })
    ).toEqual({ allowed: true });
  });

  it('denies counterparty not on allowlist when allowlist is non-empty', () => {
    const decision = evaluateAgentPolicy(
      { ...basePolicy, allowedCounterparties: ['bc1qknownseller'] },
      { ...baseAction, kind: 'cat21_transfer', counterpartyAddress: 'bc1qstranger' }
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('counterparty-not-allowed');
  });

  it('allows counterparty present on the allowlist', () => {
    expect(
      evaluateAgentPolicy(
        { ...basePolicy, allowedCounterparties: ['bc1qknownbuyer'] },
        { ...baseAction, kind: 'cat21_transfer', counterpartyAddress: 'bc1qknownbuyer' }
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

    it('fee-rate deny precedes floor-price deny on a cat21_accept_offer that trips both', () => {
      const decision = evaluateAgentPolicy(
        { ...basePolicy, maxFeeRateSatPerVbyte: 1, floorPriceSatsPerCat: 1_000_000 },
        {
          ...baseAction,
          kind: 'cat21_accept_offer',
          feeRateSatPerVbyte: 100,
          receivePriceSats: 1,
        }
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('fee-rate-above-ceiling');
    });

    it('returns "agent-disabled" when EVERY gate would trip simultaneously', () => {
      // Full-chain stress test: one input simultaneously fails every
      // single gate. Cheapest-first ordering demands the very first one
      // ('agent-disabled') wins. A refactor that quietly moves any
      // gate before the enabled check would surface a different reason
      // and fail this test.
      const decision = evaluateAgentPolicy(
        {
          enabled: false,
          maxSpendPerActionSats: 1,
          dailyCapSats: 1,
          maxFeeRateSatPerVbyte: 1,
          floorPriceSatsPerCat: 1_000_000,
          allowedCounterparties: ['bc1qknownbuyer'],
        },
        {
          kind: 'cat21_accept_offer',
          spendSats: 1_000_000,
          spentTodaySats: 1_000_000,
          feeRateSatPerVbyte: 1_000,
          receivePriceSats: 1,
          counterpartyAddress: 'bc1qstranger',
        }
      );
      expect(decision).toEqual({ allowed: false, reason: 'agent-disabled' });
    });

    it('floor-price deny precedes counterparty deny on a cat21_accept_offer that trips both', () => {
      const decision = evaluateAgentPolicy(
        {
          ...basePolicy,
          floorPriceSatsPerCat: 1_000_000,
          allowedCounterparties: ['bc1qknownbuyer'],
        },
        {
          ...baseAction,
          kind: 'cat21_accept_offer',
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
        { ...baseAction, kind: 'cat21_transfer', counterpartyAddress: '' }
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('counterparty-not-allowed');
    });
  });

  describe('Round-2 Finding 2 — floor-price gate also fires on cat21_create_offer (autonomous-undercut defence)', () => {

    it('denies cat21_create_offer when listing price is below floor', () => {
      const result = evaluateAgentPolicy(
        { ...basePolicy, floorPriceSatsPerCat: 100_000 },
        { ...baseAction, kind: 'cat21_create_offer', receivePriceSats: 50_000 }
      );
      expect(result).toEqual({
        allowed: false,
        reason: 'price-below-floor',
        detail: '50000 < 100000',
      });
    });

    it('allows cat21_create_offer when listing price equals floor', () => {
      expect(
        evaluateAgentPolicy(
          { ...basePolicy, floorPriceSatsPerCat: 100_000 },
          { ...baseAction, kind: 'cat21_create_offer', receivePriceSats: 100_000 }
        )
      ).toEqual({ allowed: true });
    });

    it('allows cat21_create_offer when listing price exceeds floor', () => {
      expect(
        evaluateAgentPolicy(
          { ...basePolicy, floorPriceSatsPerCat: 100_000 },
          { ...baseAction, kind: 'cat21_create_offer', receivePriceSats: 250_000 }
        )
      ).toEqual({ allowed: true });
    });

    it('treats cat21_create_offer without receivePriceSats as 0 (denies if floor > 0)', () => {
      const result = evaluateAgentPolicy(
        { ...basePolicy, floorPriceSatsPerCat: 1 },
        { ...baseAction, kind: 'cat21_create_offer' /* receivePriceSats omitted */ }
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe('price-below-floor');
    });

    it('cat21_mint and cat21_transfer remain exempt from the floor-price gate (no price field)', () => {
      // These flows don't have a receivePriceSats semantic. The spend
      // cap + fee-rate ceiling are the relevant gates there.
      expect(
        evaluateAgentPolicy(
          { ...basePolicy, floorPriceSatsPerCat: 1_000_000 },
          { ...baseAction, kind: 'cat21_mint' }
        )
      ).toEqual({ allowed: true });
      expect(
        evaluateAgentPolicy(
          { ...basePolicy, floorPriceSatsPerCat: 1_000_000 },
          { ...baseAction, kind: 'cat21_transfer', counterpartyAddress: 'bc1qrecipient' }
        )
      ).toEqual({ allowed: true });
    });
  });

  describe('Finding #12 — cat21_accept_offer + counterparty allowlist combined', () => {

    it('on cat21_accept_offer, denies a price-above-floor offer from an unknown buyer', () => {
      const decision = evaluateAgentPolicy(
        { ...basePolicy, allowedCounterparties: ['bc1qknownbuyer'] },
        {
          ...baseAction,
          kind: 'cat21_accept_offer',
          receivePriceSats: basePolicy.floorPriceSatsPerCat + 1_000,
          counterpartyAddress: 'bc1qstranger',
        }
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('counterparty-not-allowed');
    });

    it('on cat21_accept_offer, allows a price-above-floor offer from a known buyer', () => {
      expect(
        evaluateAgentPolicy(
          { ...basePolicy, allowedCounterparties: ['bc1qknownbuyer'] },
          {
            ...baseAction,
            kind: 'cat21_accept_offer',
            receivePriceSats: basePolicy.floorPriceSatsPerCat + 1_000,
            counterpartyAddress: 'bc1qknownbuyer',
          }
        )
      ).toEqual({ allowed: true });
    });
  });

  // The 2026-07-25 code review (finding #10) caught that every `>`
  // comparison in this gate silently returns false for NaN, so a
  // caller that hands us `spendSats: NaN` sails through. Same class
  // of bug for Infinity and negatives. These specs pin the shape
  // rejection at the top of the gate.
  describe('Finding #10 — malformed numeric fields cannot bypass the gate', () => {

    it.each([
      ['spendSats', NaN],
      ['spendSats', Infinity],
      ['spendSats', -Infinity],
      ['spendSats', -1],
      ['spentTodaySats', NaN],
      ['spentTodaySats', -1],
      ['feeRateSatPerVbyte', NaN],
      ['feeRateSatPerVbyte', -1],
    ])('rejects on action.%s = %p', (field, value) => {
      const decision = evaluateAgentPolicy(basePolicy, {
        ...baseAction,
        [field]: value,
      });
      expect(decision).toEqual({
        allowed: false,
        reason: 'malformed-numeric-field',
        detail: expect.stringContaining(`action.${field}`),
      });
    });

    it.each([
      ['maxSpendPerActionSats', NaN],
      ['maxSpendPerActionSats', -1],
      ['dailyCapSats', NaN],
      ['dailyCapSats', Infinity],
      ['maxFeeRateSatPerVbyte', NaN],
      ['floorPriceSatsPerCat', NaN],
    ])('rejects on policy.%s = %p', (field, value) => {
      const decision = evaluateAgentPolicy(
        { ...basePolicy, [field]: value },
        baseAction,
      );
      expect(decision).toEqual({
        allowed: false,
        reason: 'malformed-numeric-field',
        detail: expect.stringContaining(`policy.${field}`),
      });
    });

    it('rejects on action.receivePriceSats = NaN for offer flows', () => {
      const decision = evaluateAgentPolicy(basePolicy, {
        ...baseAction,
        kind: 'cat21_accept_offer',
        receivePriceSats: NaN,
      });
      expect(decision).toEqual({
        allowed: false,
        reason: 'malformed-numeric-field',
        detail: expect.stringContaining('action.receivePriceSats'),
      });
    });

    it('receivePriceSats absent (undefined) on mint/transfer is fine — shape guard only fires on offer flows', () => {
      // baseAction is 'cat21_mint' with no receivePriceSats. The
      // guard should NOT fire on absent price for non-offer flows.
      expect(evaluateAgentPolicy(basePolicy, baseAction)).toEqual({ allowed: true });
    });

    it('does NOT reject on legitimate zero values (0-spend, 0-fee is valid — pins the >= 0 threshold)', () => {
      const decision = evaluateAgentPolicy(basePolicy, {
        ...baseAction,
        spendSats: 0,
        spentTodaySats: 0,
        feeRateSatPerVbyte: 0,
      });
      expect(decision).toEqual({ allowed: true });
    });
  });
});
