import { RecommendedFees } from './cat21.service.types.js';

/**
 * A real `/api/v1/fees/recommended` response, captured from
 * api.ordpool.space on 2026-09-18T07:56:42Z. Frozen sample: it describes what
 * the endpoint actually answered at one moment, so the numbers do not drift
 * and do not need to.
 *
 * Exists so no consumer hand-writes a body to stand in for this endpoint. A
 * hand-written body is an assumption about a contract, and an assumption
 * written by whoever also wrote the consuming code agrees with that code while
 * both can disagree with the server. Sourcing every stand-in here means a
 * contract change reds this package rather than leaving consumer suites green.
 *
 * The captured sample has every tier at 1 to 2 sat/vB, because that is what a
 * quiet mempool answers. A spec that needs the tiers to be DISTINGUISHABLE
 * (a picker rendering three different quick-picks, an assertion that halfHour
 * beats hour) must say so at the call site:
 *
 *     recommendedFeesFixture({ fastestFee: 40, halfHourFee: 20, hourFee: 10 })
 *
 * That keeps the invented spread visible in the spec that depends on it,
 * instead of buried in a fixture where a later reader would take it for
 * observed data.
 */
export function recommendedFeesFixture(overrides: Partial<RecommendedFees> = {}): RecommendedFees {
  return {
    fastestFee: 2,
    halfHourFee: 1,
    hourFee: 1,
    economyFee: 1,
    minimumFee: 1,
    ...overrides,

  };
}
