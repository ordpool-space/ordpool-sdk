/**
 * User-configured policy that every autonomous CAT-21 action must satisfy
 * before the SDK lets it proceed. Each agent / bot stores this struct
 * locally; the SDK is stateless and just evaluates a (policy, action) pair.
 *
 * All amounts are sats so there is no float arithmetic on the safety path.
 * The "daily" cap is enforced against `spentTodaySats` passed in via the
 * action context (callers are responsible for tracking their own running
 * total — the SDK does not persist state).
 */
export interface AgentPolicy {
  enabled: boolean;
  /** Per-action sat ceiling. Hard cap; no autonomous tx may exceed this. */
  maxSpendPerActionSats: number;
  /** Daily aggregate cap. Caller resets at the boundary they prefer. */
  dailyCapSats: number;
  /** Fee-rate ceiling in sat/vB. Defends against fee runaway during congestion. */
  maxFeeRateSatPerVbyte: number;
  /** Minimum acceptable price when the agent might sell a cat we own. */
  floorPriceSatsPerCat: number;
  /**
   * Counterparty allowlist. Empty array = allow any counterparty.
   * Non-empty = strict allowlist (Bitcoin address match).
   */
  allowedCounterparties: string[];
}

export type AgentActionKind = 'mint' | 'buy' | 'sell-accept';

export interface AgentActionContext {
  kind: AgentActionKind;
  /** Sats the agent commits on this action (mint fee+postage, or buy price). */
  spendSats: number;
  /** sat/vB the agent intends to pay. */
  feeRateSatPerVbyte: number;
  /** Counterparty address (seller for buy, buyer for sell-accept). */
  counterpartyAddress?: string;
  /** For sell-accept: the price we'd receive in sats. */
  receivePriceSats?: number;
  /** Sats already spent today by the agent. Caller passes the rolling sum. */
  spentTodaySats: number;
}

export type AgentPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: AgentPolicyDenyReason; detail?: string };

export type AgentPolicyDenyReason =
  | 'agent-disabled'
  | 'spend-above-action-cap'
  | 'spend-above-daily-cap'
  | 'fee-rate-above-ceiling'
  | 'price-below-floor'
  | 'counterparty-not-allowed';
