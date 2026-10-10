/**
 * "Is this element visible within N ms?", for an optional step INSIDE an SDK
 * helper (a wallet's onboarding screen that some releases skip). Not part of
 * the `ordpool-sdk/e2e` surface: a probe like this lives only inside an SDK
 * helper, with its duration a named constant that says why (TESTING.md). A
 * spec races the event against the state that means it is not coming instead
 * (`raceApprovalPopup`).
 *
 * `locator.isVisible({ timeout })` does not do this. Playwright's own types say
 * so (the option is declared and marked `@deprecated This option is ignored`,
 * with "does not wait for the element to become visible and returns
 * immediately"), but it still TYPECHECKS, so the call compiles, reads as a
 * wait, and answers instantly.
 *
 * The damage is specific to the pattern it is always written in: dismiss a
 * dialog if it is there, then click the thing behind it. When the dialog has
 * not rendered yet, the instant check says "not there", the dismissal is
 * skipped, and the next click lands on an overlay that appeared a moment later.
 * The failure then surfaces at the click, or later still at whatever the click
 * was supposed to produce.
 *
 * `waitFor` is not a drop-in replacement here, because it throws when the
 * element legitimately never appears, which for an optional dialog is the
 * normal case. This waits and answers the question.
 */
export interface WaitableLocator {
    waitFor(options: {
        state: 'visible';
        timeout: number;
    }): Promise<void>;
}
/**
 * Resolves `true` if the element becomes visible within `probeMs`, `false` if
 * it does not. Never throws for absence.
 */
export declare function isVisibleWithin(locator: WaitableLocator, probeMs: number): Promise<boolean>;
//# sourceMappingURL=is-visible-within.d.ts.map