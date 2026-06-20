import { PsbtSigningTarget } from '../wallet.service.types';
/**
 * Both `SignMultiInputAndBroadcastInput` and `SignPsbtOnlyInput` carry a
 * `signingMap`. The helper only consults that field, so we pin the
 * argument shape to just it — keeps both call sites usable from one
 * helper without an unsound union.
 */
type WithSigningMap = {
    signingMap: ReadonlyArray<PsbtSigningTarget>;
};
/**
 * Normalises a signingMap to a non-empty array of fully-defaulted
 * rows. Per-row `sigHash` defaults to SIGHASH_ALL — every cat-flow
 * we ship today commits under SIGHASH_ALL, single source for the
 * default lives here so the 10+ signers don't each repeat it.
 *
 * Throws if the signingMap is empty — that's a caller bug, not a
 * runtime degradation.
 */
export declare function resolveSigningTargets(input: WithSigningMap): ReadonlyArray<Required<PsbtSigningTarget>>;
export {};
//# sourceMappingURL=signing-targets.helper.d.ts.map