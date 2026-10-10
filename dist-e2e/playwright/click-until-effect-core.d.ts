/**
 * The loop behind `clickUntilEffect` and `clickUntilApprovalPopup`, with the
 * probe duration as a parameter. Not part of the `ordpool-sdk/e2e` surface:
 * a probe duration is a named constant inside an SDK helper (TESTING.md), never
 * a value a spec passes.
 */
import type { ClickableControl, ClickUntilEffectOptions, ClickUntilEffectResult, EffectLocator } from './click-until-effect';
export declare function clickUntilEffectWithProbe(control: ClickableControl, effect: EffectLocator, options: ClickUntilEffectOptions, probeMs: number): Promise<ClickUntilEffectResult>;
//# sourceMappingURL=click-until-effect-core.d.ts.map