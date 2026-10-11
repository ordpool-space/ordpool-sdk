import { Locator, Page } from '@playwright/test';
/**
 * Drive Phantom v26 onboarding from welcome to the "You're good to go"
 * completion screen. Multi-page flow (CI iterations 22-30, 2026-05-31):
 *
 *   - Welcome → "I Already Have a Wallet" (anti-automation filter,
 *     needs raw CDP Input.dispatchMouseEvent).
 *   - Import-a-wallet picker → "Import Recovery Phrase".
 *   - 12 mnemonic input boxes → Import Wallet.
 *   - "Import Accounts — Finding Accounts with Activity" loading,
 *     transitions to "We found N accounts with activity" result. The
 *     result may render on a NEW page (Phantom replaces the tab); poll
 *     context.pages() for the result-state marker.
 *   - Continue (rendered as a styled <div>, not a real button) once
 *     Phantom finishes deriving account info (opacity gate).
 *   - YET another new page for "Create a password" — switch reference.
 *   - Password + Confirm Password fields; the Reach UI custom-checkbox
 *     Terms (`tickPhantomTerms`); Continue.
 *   - "You're good to go!" completion screen with a "Get Started" CTA.
 *     Onboarding is complete at this screen: the wallet is restored and
 *     unlocked. This returns there; callers open popup.html themselves,
 *     which does not depend on Get Started.
 */
export declare function onboardPhantom(page: Page, extensionId: string, opts?: {
    password?: string;
    mnemonicWords?: string;
}): Promise<void>;
/**
 * Tick the Terms of Service box on Phantom's "Create a password" screen.
 *
 * The box is a Reach UI custom checkbox: the `<input>` is invisible and takes
 * no pointer events, and the visible 22 px square is its container span, which
 * is what a person clicks. The click is proven by the input's `aria-checked`.
 */
export declare function tickPhantomTerms(page: Page): Promise<void>;
/** `tickPhantomTerms` on its two controls: the visible box, and the input once checked. */
export declare function tickPhantomTermsControls(c: {
    box: Pick<Locator, 'click'>;
    checked: Pick<Locator, 'waitFor'>;
}): Promise<void>;
//# sourceMappingURL=onboard-phantom.d.ts.map