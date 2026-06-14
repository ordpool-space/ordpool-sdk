import {
  AgentActionContext,
  AgentPolicy,
  AgentPolicyDecision,
  AgentPolicyDenyReason,
} from './agent-policy.types';

/**
 * Pure-functional policy gate for agent-mode autonomous CAT-21 actions.
 *
 * Every autonomous mint / buy / sell-accept must pass through this gate
 * BEFORE the agent constructs a PSBT or asks the wallet to sign. A deny
 * decision short-circuits the action with a typed reason; the caller
 * surfaces the reason verbatim to the user (or logs it for the bot).
 *
 * Order of checks is cheapest first so we don't burn CPU on an action
 * that fails for a simple reason. The action-cap is usually more
 * restrictive than the daily-cap so it comes first.
 *
 * Counterparty check is substring/equality on Bitcoin addresses — no
 * BIP-32 re-derivation, no DNS resolution. The caller already knows the
 * exact address being paid / received and passes it through.
 */
export function evaluateAgentPolicy(
  policy: AgentPolicy,
  action: AgentActionContext
): AgentPolicyDecision {
  if (!policy.enabled) {
    return deny('agent-disabled');
  }
  if (action.spendSats > policy.maxSpendPerActionSats) {
    return deny(
      'spend-above-action-cap',
      `${action.spendSats} > ${policy.maxSpendPerActionSats}`
    );
  }
  if (action.spentTodaySats + action.spendSats > policy.dailyCapSats) {
    return deny(
      'spend-above-daily-cap',
      `${action.spentTodaySats} + ${action.spendSats} > ${policy.dailyCapSats}`
    );
  }
  if (action.feeRateSatPerVbyte > policy.maxFeeRateSatPerVbyte) {
    return deny(
      'fee-rate-above-ceiling',
      `${action.feeRateSatPerVbyte} > ${policy.maxFeeRateSatPerVbyte}`
    );
  }
  if (action.kind === 'sell-accept') {
    const receivePrice = action.receivePriceSats ?? 0;
    if (receivePrice < policy.floorPriceSatsPerCat) {
      return deny(
        'price-below-floor',
        `${receivePrice} < ${policy.floorPriceSatsPerCat}`
      );
    }
  }
  if (
    policy.allowedCounterparties.length > 0 &&
    action.counterpartyAddress !== undefined &&
    !policy.allowedCounterparties.includes(action.counterpartyAddress)
  ) {
    return deny('counterparty-not-allowed', action.counterpartyAddress);
  }
  return { allowed: true };
}

function deny(reason: AgentPolicyDenyReason, detail?: string): AgentPolicyDecision {
  return { allowed: false, reason, detail };
}
