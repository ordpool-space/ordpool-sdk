import {
  AgentActionContext,
  AgentPolicy,
  AgentPolicyDecision,
  AgentPolicyDenyReason,
} from './agent-policy.types';

/**
 * Pure-functional policy gate for agent-mode autonomous CAT-21 actions.
 *
 * Every autonomous `cat21_*` action must pass through this gate BEFORE
 * the agent constructs a PSBT or asks the wallet to sign. A deny
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
 *
 * Floor-price check fires on the two flows where the policy has price
 * agency:
 *   - `cat21_accept_offer`: a counterparty's inbound PSBT pays us less
 *     than our floor (REACTIVE — we either sign or don't).
 *   - `cat21_create_offer`: the bot autonomously proposes to list our
 *     cat below our floor (PROACTIVE — the bot picks the price). The
 *     undercut-prevention case the audit caught; arguably the more
 *     important of the two since publish-time is the moment the
 *     autonomous policy actually has agency.
 *
 * `cat21_mint` and `cat21_transfer` have no price semantic; spend caps
 * + fee-rate ceiling are sufficient there.
 */
export function evaluateAgentPolicy(
  policy: AgentPolicy,
  action: AgentActionContext
): AgentPolicyDecision {
  if (!policy.enabled) {
    return deny('agent-disabled');
  }

  // Shape guards. NaN silently bypasses every `>` comparison below
  // (`NaN > anything === false`), so a caller that hands us
  // `spendSats: NaN` — an LLM tool-call that parsed a bad number,
  // a division-by-zero, a JSON-stringified undefined — sails through
  // the gate. ±Infinity and negatives are also nonsense for sat
  // amounts / fee rates. Reject on shape before the value comparisons
  // so the gate has no bypass on malformed input.
  //
  // BOTH sides — action AND policy — need the guard: a broken policy
  // (e.g. `maxSpendPerActionSats: NaN` from a corrupted Redux state)
  // is arguably worse than a broken action.
  const shapeFail =
    ensureFiniteNonNeg('action.spendSats', action.spendSats)
    ?? ensureFiniteNonNeg('action.spentTodaySats', action.spentTodaySats)
    ?? ensureFiniteNonNeg('action.feeRateSatPerVbyte', action.feeRateSatPerVbyte)
    ?? ensureFiniteNonNeg('policy.maxSpendPerActionSats', policy.maxSpendPerActionSats)
    ?? ensureFiniteNonNeg('policy.dailyCapSats', policy.dailyCapSats)
    ?? ensureFiniteNonNeg('policy.maxFeeRateSatPerVbyte', policy.maxFeeRateSatPerVbyte)
    ?? ensureFiniteNonNeg('policy.floorPriceSatsPerCat', policy.floorPriceSatsPerCat)
    ?? (action.kind === 'cat21_accept_offer' || action.kind === 'cat21_create_offer'
      // receivePriceSats is optional; when present it must be well-shaped.
      ? ensureFiniteNonNeg('action.receivePriceSats', action.receivePriceSats ?? 0)
      : null);
  if (shapeFail !== null) return shapeFail;

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
  if (action.kind === 'cat21_accept_offer' || action.kind === 'cat21_create_offer') {
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

/**
 * Returns a deny decision when `value` isn't a finite, non-negative
 * number; returns null on ok. Callers chain via `??` to fail fast
 * on the first bad field.
 */
function ensureFiniteNonNeg(fieldName: string, value: unknown): AgentPolicyDecision | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return deny(
      'malformed-numeric-field',
      `${fieldName} must be a finite non-negative number; got ${String(value)}`,
    );
  }
  return null;
}

function deny(reason: AgentPolicyDenyReason, detail?: string): AgentPolicyDecision {
  return { allowed: false, reason, detail };
}
