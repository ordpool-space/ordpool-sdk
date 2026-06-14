/**
 * Agent-mode policy — the user-configured contract every autonomous action
 * must satisfy before it can sign or broadcast.
 *
 * Per the plan, autonomous actions in v1 are:
 *   1. Mint a CAT-21 cat (priced by fee rate, no counterparty).
 *   2. Buy a cat via an inbound ord-style offer (priced by `priceSats`).
 *   3. Sell a cat via an outbound accept on an offer received (priced by
 *      the offer's `priceSats`).
 *
 * Each kind has its own gates. Limits stored in sats so there is no float
 * arithmetic on the safety path. A daily cap is tracked off this struct
 * because it depends on the wallet's local activity log.
 */
export interface AgentPolicy {
  enabled: boolean;
  /** Per-action sat ceiling. Hard cap; no autonomous tx may exceed this. */
  maxSpendPerActionSats: number;
  /** Daily aggregate cap. Reset midnight UTC. */
  dailyCapSats: number;
  /** Fee-rate ceiling in sat/vB. Defends against fee-rate runaway during congestion. */
  maxFeeRateSatPerVbyte: number;
  /** Buyer-only: minimum acceptable price for a cat we own and the agent might sell. */
  floorPriceSatsPerCat: number;
  /** Counterparty allowlist. Empty list = allow all (NOT recommended for v1). */
  allowedCounterparties: string[];
}

export type AgentActionKind = 'mint' | 'buy' | 'sell-accept';

export interface AgentActionContext {
  kind: AgentActionKind;
  /** Sats the agent is committing on this action (mint fee+postage, or buy price). */
  spendSats: number;
  /** sat/vB the agent intends to pay. */
  feeRateSatPerVbyte: number;
  /** Bitcoin address of the counterparty (seller-payment for buy, buyer-receive for sell). */
  counterpartyAddress?: string;
  /** For sell-accept: the price we'd receive in sats. */
  receivePriceSats?: number;
  /** Sats already spent today by the agent. UI passes the rolling sum. */
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
