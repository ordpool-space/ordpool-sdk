/**
 * Placement for a dirty-coin guard spec, verified rather than guessed.
 *
 * A guard spec only proves something if the dirty coin is the coin an
 * UNGUARDED selection would actually have taken. Selection picks the SMALLEST
 * covering candidate, which leaves two ways to get it wrong, and both produce a
 * passing spec that proves nothing:
 *
 *   too LARGE  the coin is never a best-fit candidate; selection takes the
 *              smaller clean coin whether the guard is there or not
 *   too SMALL  the coin does not COVER the requirement, so selection reaches
 *              straight past it, again with or without the guard
 *
 * The requirement is FLOW-SPECIFIC (a cat mint needs roughly postage plus fee;
 * an inscribe needs far more), so a number that works for one flow is wrong for
 * another and carrying numbers between repos is how they drift.
 *
 * So this does not hand out numbers. It checks the premise against the pool the
 * flow will actually see, and names which trap was hit when it fails. Call it
 * after seeding and before running the flow: a spec whose premise is false
 * should say so at the setup, not fail later on the assertion under test.
 */

export interface PlacementUtxo {
  txid: string;
  vout: number;
  value: number;
}

/**
 * Throw unless `dirtyOutpoint` is the coin an unguarded best-fit selection
 * would take from `pool`.
 *
 * @param requirementSats What the flow must cover. MEASURE it (simulate the
 *   flow, read the fee plus outputs); do not guess, because a guessed
 *   requirement silently moves which trap you are in.
 * @param preferredSats The flow's CHANGE-HEADROOM target, when it has one
 *   (`preferredTarget` in the cores: the with-change fee plus a dust floor on
 *   top of the outputs). Selection prefers a coin clearing this whenever ANY
 *   candidate does, so a coin that merely covers `requirementSats` is skipped
 *   in a pool where something else clears headroom. Omitting it checks a
 *   weaker premise than the flow actually applies.
 */
export function assertDirtyCoinIsBestFit(
  pool: ReadonlyArray<PlacementUtxo>,
  dirtyOutpoint: string,
  requirementSats: number,
  preferredSats?: number,
): void {
  const at = (u: PlacementUtxo) => `${u.txid}:${u.vout}`;
  const dirty = pool.find(u => at(u) === dirtyOutpoint);
  if (dirty === undefined) {
    throw new Error(
      `dirty-coin placement: ${dirtyOutpoint} is not in the pool at all (${pool.length} coins). ` +
      'Seeding went to a different address, or the flow reads a different one.',
    );
  }

  if (dirty.value < requirementSats) {
    throw new Error(
      `dirty-coin placement: the dirty coin holds ${dirty.value} sats and the flow needs ` +
      `${requirementSats}, so selection reaches PAST it and the guard is never consulted. ` +
      'Seed it just ABOVE the requirement.',
    );
  }

  const covering = pool.filter(u => u.value >= requirementSats);
  if (covering.length < 2) {
    throw new Error(
      `dirty-coin placement: only ${covering.length} coin covers ${requirementSats} sats, so there is ` +
      'no clean alternative to steer to. That proves the guard FLAGS, not that selection AVOIDS. ' +
      'Add a clean coin well above the requirement.',
    );
  }

  // Mirror the selection rule rather than approximating it. `recommendFunding`
  // biases toward candidates clearing the change-headroom target whenever any
  // clears it, and falls back to the whole covering set when none does. A guard
  // that only knows the feasibility target passes a coin the flow will never
  // take, which reads afterwards as the coin being protected by something.
  const headroom =
    preferredSats !== undefined && preferredSats > requirementSats
      ? covering.filter((u) => u.value >= preferredSats)
      : [];
  const selectable = headroom.length > 0 ? headroom : covering;

  if (headroom.length > 0 && !selectable.some((u) => at(u) === dirtyOutpoint)) {
    throw new Error(
      `dirty-coin placement: the dirty coin holds ${dirty.value} sats, which covers the ${requirementSats} ` +
      `requirement but not the ${preferredSats} change-headroom target, while ${headroom.length} other ` +
      'coin(s) do clear it. Selection prefers those, so it never considers the dirty coin and the ' +
      'mutation proves nothing. Seed it at or above the headroom target.',
    );
  }

  const smallestCovering = [...selectable].sort((a, b) => a.value - b.value)[0];
  if (at(smallestCovering) !== dirtyOutpoint) {
    throw new Error(
      `dirty-coin placement: the smallest covering coin is ${at(smallestCovering)} at ` +
      `${smallestCovering.value} sats, not the dirty ${dirtyOutpoint} at ${dirty.value}. ` +
      'An unguarded selection would take the clean one anyway, so the mutation proves nothing. ' +
      'Seed the dirty coin BELOW every clean covering coin.',
    );
  }
}
