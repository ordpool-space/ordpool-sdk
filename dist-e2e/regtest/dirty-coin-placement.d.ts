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
export declare function assertDirtyCoinIsBestFit(pool: ReadonlyArray<PlacementUtxo>, dirtyOutpoint: string, requirementSats: number, preferredSats?: number): void;
//# sourceMappingURL=dirty-coin-placement.d.ts.map