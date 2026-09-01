import { Page } from '@playwright/test';
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
 *   - Password + Confirm Password fields; Reach UI custom-checkbox
 *     Terms (the <input> is visually hidden, dispatch native .click()
 *     via JS so React's onChange toggles aria-checked); Continue.
 *   - "You're good to go!" completion gate with a "Get Started" CTA.
 *     The button is bombproof against every click strategy tried
 *     (CDP / pointer / programmatic / Tab+Enter). We attempt one
 *     CDP+pointer-event volley and leave the wallet on the completion
 *     screen — callers can navigate to popup.html afterwards.
 */
export declare function onboardPhantom(page: Page, extensionId: string, opts?: {
    password?: string;
    mnemonicWords?: string;
}): Promise<void>;
//# sourceMappingURL=onboard-phantom.d.ts.map