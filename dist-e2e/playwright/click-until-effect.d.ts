/**
 * Click a control whose enabled state is computed from data that settles after
 * first paint, and confirm the effect actually happened.
 *
 * A control bound to async state can be re-rendered in the moment between its
 * locator resolving and the event landing, which swallows the click. Nothing
 * fails there: the spec fails on the NEXT assertion and reports the drawer,
 * dialog or popup that was supposed to open as a missing element, one step
 * removed from the cause.
 *
 * Every funding-gated surface in this family is in that position by
 * construction, because `scanning` is a real CTA state fed by an async content
 * scan.
 *
 * ## Why this is not a retry that hides a defect
 *
 * A second click is only sent when the control is STILL IN ITS PRE-CLICK
 * STATE: visible, enabled, and the effect absent. That combination is the
 * signature of a click that never registered. If the control went disabled or
 * disappeared, the click DID register and something downstream is merely slow,
 * so this keeps waiting instead of clicking again. A control that never yields
 * the effect still fails, with the click count and the last observed state in
 * the message.
 *
 * That distinction is load-bearing on a money path. A CTA that does not disable
 * itself while it works would otherwise take a second click and start a second
 * mint, transfer or offer. The check belongs here rather than in the luck of a
 * particular button's implementation.
 *
 * ## Precondition: the control must REPEAT its action, not toggle it
 *
 * This is for a control where clicking twice attempts the same thing twice. It
 * is WRONG for a toggle: a `<details>` summary, a disclosure, a switch. Such a
 * control stays visible and enabled after opening, so the default
 * still-in-pre-click test reads "the click was swallowed" and the second click
 * CLOSES what the first one opened, turning a slow render into a guaranteed
 * failure.
 *
 * A toggle can still be hardened here by passing `stillPreClick`, which
 * replaces that test with the control's own state (`open` on a `<details>`, an
 * `aria-expanded` attribute). Then a second click is sent only when the toggle
 * genuinely never flipped.
 */
export interface ClickUntilEffectOptions {
    /** Total clicks allowed, including the first. */
    maxClicks?: number;
    /** How long one click gets to produce the effect. */
    settleMs?: number;
    /** Name used in the failure message. Defaults to the control's selector. */
    label?: string;
    /**
     * Whether the control is still in its pre-click state, i.e. the click did not
     * register. Defaults to "visible and enabled", which is right for a button
     * that repeats its action. A TOGGLE must override this with its own open
     * state, or the second click undoes the first. Returning false means the
     * control reacted, and no further click is sent.
     */
    stillPreClick?: () => Promise<boolean>;
}
/**
 * The part of a Playwright `Locator` this needs. Structural so the decision
 * logic is unit-testable without a browser: the swallowed-click branch is the
 * one that must never fire on a control that already reacted, and that is a
 * property of the code, not of Chromium.
 */
export interface ClickableControl {
    click(): Promise<void>;
    isVisible(): Promise<boolean>;
    isEnabled(): Promise<boolean>;
}
/** The part of a `Locator` used to observe the effect. */
export interface EffectLocator {
    waitFor(options: {
        state: 'visible';
        timeout: number;
    }): Promise<void>;
}
export interface ClickUntilEffectResult {
    /** Clicks actually sent. More than 1 means a click was swallowed. */
    clicks: number;
}
/**
 * Click `control` until `effect` is visible. Returns how many clicks it took,
 * so a caller can log or assert that a surface needed only one.
 */
export declare function clickUntilEffect(control: ClickableControl, effect: EffectLocator, options?: ClickUntilEffectOptions): Promise<ClickUntilEffectResult>;
//# sourceMappingURL=click-until-effect.d.ts.map