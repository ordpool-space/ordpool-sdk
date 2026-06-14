import { injectable } from 'inversify';

import {
  AgentActionContext,
  AgentPolicy,
  AgentPolicyDecision,
} from './agent-policy.types';

/**
 * Pure-functional policy gate for agent-mode autonomous actions.
 *
 * Every autonomous mint / buy / sell-accept must pass through `evaluate`
 * BEFORE the wallet signs anything. A deny decision short-circuits the
 * action with a typed reason; the UI / MCP server surfaces the reason
 * verbatim without leaking other policy fields.
 *
 * Order of checks matters: cheapest gates first so we don't burn CPU on
 * a tx that fails for a simple reason. The action-cap is more restrictive
 * than the daily-cap typically, so it comes before the daily-cap check.
 *
 * Counterparty check is intentionally a substring/equality match — no fancy
 * BIP-32 address re-derivation — because the caller already knows the
 * address it intends to pay/receive and is passing it through.
 */
@injectable()
export class AgentPolicyService {
  public evaluate(policy: AgentPolicy, action: AgentActionContext): AgentPolicyDecision {
    if (!policy.enabled) {
      return { allowed: false, reason: 'agent-disabled' };
    }
    if (action.spendSats > policy.maxSpendPerActionSats) {
      return {
        allowed: false,
        reason: 'spend-above-action-cap',
        detail: `${action.spendSats} > ${policy.maxSpendPerActionSats}`,
      };
    }
    if (action.spentTodaySats + action.spendSats > policy.dailyCapSats) {
      return {
        allowed: false,
        reason: 'spend-above-daily-cap',
        detail: `${action.spentTodaySats} + ${action.spendSats} > ${policy.dailyCapSats}`,
      };
    }
    if (action.feeRateSatPerVbyte > policy.maxFeeRateSatPerVbyte) {
      return {
        allowed: false,
        reason: 'fee-rate-above-ceiling',
        detail: `${action.feeRateSatPerVbyte} > ${policy.maxFeeRateSatPerVbyte}`,
      };
    }
    if (action.kind === 'sell-accept') {
      const receivePrice = action.receivePriceSats ?? 0;
      if (receivePrice < policy.floorPriceSatsPerCat) {
        return {
          allowed: false,
          reason: 'price-below-floor',
          detail: `${receivePrice} < ${policy.floorPriceSatsPerCat}`,
        };
      }
    }
    if (
      policy.allowedCounterparties.length > 0 &&
      action.counterpartyAddress !== undefined &&
      !policy.allowedCounterparties.includes(action.counterpartyAddress)
    ) {
      return {
        allowed: false,
        reason: 'counterparty-not-allowed',
        detail: action.counterpartyAddress,
      };
    }
    return { allowed: true };
  }
}
