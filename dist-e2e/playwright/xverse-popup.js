"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.XVERSE_CONNECT_BUTTON = void 0;
exports.unlockXverseControls = unlockXverseControls;
exports.unlockXverse = unlockXverse;
exports.unlockXversePage = unlockXversePage;
exports.approveXverseConnect = approveXverseConnect;
const approval_popup_1 = require("./approval-popup");
const wallet_test_vectors_1 = require("./wallet-test-vectors");
/** The consent button of Xverse 2.3.2's connect popup (sats-connect `getAddress`). */
exports.XVERSE_CONNECT_BUTTON = /^(connect|approve|confirm|allow)$/i;
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
async function unlockXverseControls(controls, password) {
    await controls.settled.waitFor({ state: 'visible' });
    if (await controls.password.isVisible()) {
        await controls.password.fill(password);
        await controls.unlock.click();
    }
    await controls.home.waitFor({ state: 'visible' });
}
/**
 * Open Xverse's popup in a tab and unlock it with the test password. Returns
 * the page on the home screen.
 *
 * The home screen is anchored on "Account 1", the account header only the
 * unlocked wallet renders.
 */
async function unlockXverse(context, extensionId, opts = {}) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await unlockXversePage(page, opts);
    return page;
}
/** `unlockXverse` on a page that already shows Xverse's popup. */
async function unlockXversePage(page, opts = {}) {
    const password = page.locator('input[type="password"]').first();
    const home = page.getByText('Account 1', { exact: true }).first();
    await unlockXverseControls({
        password,
        unlock: page.getByRole('button', { name: /^unlock$/i }).first(),
        home,
        settled: password.or(home).first(),
    }, opts.password ?? wallet_test_vectors_1.PASSWORD_BY_WALLET.xverse);
}
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
async function approveXverseConnect(context, request) {
    const knownPages = new Set(context.pages());
    const outcome = request().then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
    const consent = (p) => p.getByRole('button', { name: exports.XVERSE_CONNECT_BUTTON }).first();
    let popup;
    try {
        popup = await (0, approval_popup_1.waitForApprovalPopup)({ context, knownPages, isApproval: (0, approval_popup_1.approvalGate)({ control: consent }) });
    }
    catch (searchError) {
        const settled = await Promise.race([outcome, Promise.resolve(null)]);
        if (settled && !settled.ok)
            throw settled.error;
        throw searchError;
    }
    await (0, approval_popup_1.clickApprovalAndRequireClose)(consent(popup), popup, { label: 'Xverse connect popup' });
    const result = await outcome;
    if (!result.ok)
        throw result.error;
    return result.value;
}
//# sourceMappingURL=xverse-popup.js.map