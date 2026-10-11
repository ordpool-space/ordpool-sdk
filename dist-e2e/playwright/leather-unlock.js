"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEATHER_UNLOCK_BUTTON = exports.LEATHER_UNLOCK_PASSWORD_INPUT = void 0;
exports.waitForControlUnlockingIfAsked = waitForControlUnlockingIfAsked;
/**
 * The Leather-family unlock screen (`RequestPassword`, testids from the
 * wallet's `SettingsSelectors`): Leather and its fork Cat21 Wallet.
 */
exports.LEATHER_UNLOCK_PASSWORD_INPUT = 'password-input';
exports.LEATHER_UNLOCK_BUTTON = 'unlock-wallet-btn';
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
async function waitForControlUnlockingIfAsked(page, control, password) {
    // Promise.race handles both sides, so the loser rejecting later (its page
    // closing at teardown) changes nothing once one side won.
    const first = await Promise.race([
        control.waitFor({ state: 'visible' }).then(() => 'shown'),
        page.getByTestId(exports.LEATHER_UNLOCK_PASSWORD_INPUT).waitFor({ state: 'visible' }).then(() => 'locked'),
    ]);
    if (first === 'shown')
        return 'shown';
    await page.getByTestId(exports.LEATHER_UNLOCK_PASSWORD_INPUT).fill(password);
    await page.getByTestId(exports.LEATHER_UNLOCK_BUTTON).click();
    await control.waitFor({ state: 'visible' });
    return 'unlocked';
}
//# sourceMappingURL=leather-unlock.js.map