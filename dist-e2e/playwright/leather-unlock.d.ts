/**
 * The Leather-family unlock screen (`RequestPassword`, testids from the
 * wallet's `SettingsSelectors`): Leather and its fork Cat21 Wallet.
 */
export declare const LEATHER_UNLOCK_PASSWORD_INPUT = "password-input";
export declare const LEATHER_UNLOCK_BUTTON = "unlock-wallet-btn";
/** The part of a Playwright `Locator` a visibility race needs. */
export interface VisibleState {
    waitFor(options: {
        state: 'visible';
    }): Promise<void>;
}
/** The part of a Playwright `Page` the unlock needs. */
export interface UnlockablePage {
    getByTestId(testId: string): VisibleState & {
        fill(value: string): Promise<void>;
        click(): Promise<void>;
    };
}
/**
 * Wait until `control` shows on a Leather-family popup, typing the password
 * first when the popup booted locked. Returns which of the two happened.
 *
 * A popup can boot locked right after onboarding although the wallet is
 * unlocked: the page restores its key from `chrome.storage.session` before its
 * store has rehydrated from `chrome.storage.local`, finds no encrypted key to
 * decrypt, and its account gate sends it to the unlock screen
 * (`restoreWalletSession` in the wallet's `app/index.tsx` boot does not wait
 * for redux-persist). Which read finishes first is up to the browser: a slow
 * `chrome.storage.local` on a loaded runner is enough. A person answers that
 * screen with their password and the popup returns to the request
 * (`navigate(-1)`), so this does the same.
 *
 * Both outcomes are states raced under the per-wait bound. A rejection before
 * either side showed rejects; the loser's rejection after that changes nothing.
 */
export declare function waitForControlUnlockingIfAsked(page: UnlockablePage, control: VisibleState, password: string): Promise<'shown' | 'unlocked'>;
//# sourceMappingURL=leather-unlock.d.ts.map