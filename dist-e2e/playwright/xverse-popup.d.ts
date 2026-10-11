import type { BrowserContext, Locator, Page } from '@playwright/test';
/** The consent button of Xverse 2.3.2's connect popup (sats-connect `getAddress`). */
export declare const XVERSE_CONNECT_BUTTON: RegExp;
/**
 * The approve button of Xverse 2.3.2's transaction sign popup (sats-connect
 * `signTransaction` / `signPsbt`, the popup headed "Review transaction").
 */
export declare const XVERSE_SIGN_BUTTON: RegExp;
/** The part of a Playwright `Locator` the unlock needs. */
export interface XverseUnlockControls {
    /** The lock screen's password field. */
    password: Pick<Locator, 'isVisible' | 'fill'>;
    /** The lock screen's Unlock button. */
    unlock: Pick<Locator, 'click'>;
    /** A control only the unlocked home screen shows. */
    home: Pick<Locator, 'waitFor'>;
    /** Either of the two: the screen Xverse settles on after a cold start. */
    settled: Pick<Locator, 'waitFor'>;
}
/**
 * Unlock Xverse on a page showing its popup, if it asks, and return once the
 * home screen shows.
 *
 * A context cloned from the seeded profile boots into the lock screen (the
 * vault is encrypted at rest and the key is not kept across restarts); a
 * context that onboarded in this run is already unlocked. Which of the two
 * Xverse shows is read only after it settled on one of them, so the answer is
 * about the screen, not about a page that is still booting.
 */
export declare function unlockXverseControls(controls: XverseUnlockControls, password: string): Promise<void>;
/**
 * Open Xverse's popup in a tab and unlock it with the test password. Returns
 * the page on the home screen.
 *
 * The home screen is anchored on "Account 1", the account header only the
 * unlocked wallet renders.
 */
export declare function unlockXverse(context: BrowserContext, extensionId: string, opts?: {
    password?: string;
}): Promise<Page>;
/** `unlockXverse` on a page that already shows Xverse's popup. */
export declare function unlockXversePage(page: Page, opts?: {
    password?: string;
}): Promise<void>;
/**
 * Send a connect request and approve it in the popup Xverse opens for it.
 * Returns what the request resolved to.
 *
 * `request` starts the dapp-side call (the harness's `connectXverse`) and
 * resolves once the wallet answered. The popup is found among the pages that
 * open after the request went out, by its consent button. Xverse closes the
 * popup when it accepts the click, so the click requires the close
 * (`clickApprovalAndRequireClose`).
 *
 * The request's own failure is held as a value while the popup is searched
 * for, so it cannot reject unobserved; it is rethrown in place of the
 * search's error, because it names the reason the popup never came.
 */
export declare function approveXverseConnect<T>(context: BrowserContext, request: () => Promise<T>): Promise<T>;
/**
 * Approve the next transaction sign popup Xverse opens and require it to
 * close. Returns the popup page, so a caller adds it to the `knownPages` of a
 * following search (an inscribe asks twice in a row).
 *
 * The popup is the first page outside `knownPages` that shows the Confirm
 * button (`XVERSE_SIGN_BUTTON`). Xverse renders that button while it still
 * resolves the fee and the inputs, styled `pointer-events: none` until it
 * takes clicks, so the click waits for `waitForStyleClickable` first; a click
 * in that window lands on nothing. Xverse closes the popup when it accepts
 * Confirm, so the click requires the close (`clickApprovalAndRequireClose`)
 * and fails at the click, with a diagnosis, when it does not.
 *
 * Pass `onScreenshot` to capture the popup before the click.
 */
export declare function approveXverseSignPopup(opts: {
    context: BrowserContext;
    knownPages: Set<Page>;
    label?: string;
    onScreenshot?: (page: Page) => Promise<void>;
}): Promise<Page>;
//# sourceMappingURL=xverse-popup.d.ts.map