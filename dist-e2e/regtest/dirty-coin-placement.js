"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertDirtyCoinIsBestFit = assertDirtyCoinIsBestFit;
/**
 * Throw unless `dirtyOutpoint` is the coin an unguarded best-fit selection
 * would take from `pool`.
 *
 * @param requirementSats What the flow must cover. MEASURE it (simulate the
 *   flow, read the fee plus outputs); do not guess, because a guessed
 *   requirement silently moves which trap you are in.
 */
function assertDirtyCoinIsBestFit(pool, dirtyOutpoint, requirementSats) {
    const at = (u) => `${u.txid}:${u.vout}`;
    const dirty = pool.find(u => at(u) === dirtyOutpoint);
    if (dirty === undefined) {
        throw new Error(`dirty-coin placement: ${dirtyOutpoint} is not in the pool at all (${pool.length} coins). ` +
            'Seeding went to a different address, or the flow reads a different one.');
    }
    if (dirty.value < requirementSats) {
        throw new Error(`dirty-coin placement: the dirty coin holds ${dirty.value} sats and the flow needs ` +
            `${requirementSats}, so selection reaches PAST it and the guard is never consulted. ` +
            'Seed it just ABOVE the requirement.');
    }
    const covering = pool.filter(u => u.value >= requirementSats);
    if (covering.length < 2) {
        throw new Error(`dirty-coin placement: only ${covering.length} coin covers ${requirementSats} sats, so there is ` +
            'no clean alternative to steer to. That proves the guard FLAGS, not that selection AVOIDS. ' +
            'Add a clean coin well above the requirement.');
    }
    const smallestCovering = [...covering].sort((a, b) => a.value - b.value)[0];
    if (at(smallestCovering) !== dirtyOutpoint) {
        throw new Error(`dirty-coin placement: the smallest covering coin is ${at(smallestCovering)} at ` +
            `${smallestCovering.value} sats, not the dirty ${dirtyOutpoint} at ${dirty.value}. ` +
            'An unguarded selection would take the clean one anyway, so the mutation proves nothing. ' +
            'Seed the dirty coin BELOW every clean covering coin.');
    }
}
//# sourceMappingURL=dirty-coin-placement.js.map