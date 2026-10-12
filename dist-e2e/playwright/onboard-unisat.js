"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dismissUnisatUpdateNag = dismissUnisatUpdateNag;
exports.dismissUnisatUpdateNagControls = dismissUnisatUpdateNagControls;
exports.dismissUnisatNotice = dismissUnisatNotice;
exports.dismissUnisatNoticeControls = dismissUnisatNoticeControls;
exports.onboardUnisat = onboardUnisat;
exports.waitForUnisatInstallTabSettled = waitForUnisatInstallTabSettled;
const test_1 = require("@playwright/test");
const is_visible_within_1 = require("./is-visible-within");
const select_card_1 = require("./select-card");
const unisat_install_tab_1 = require("./unisat-install-tab");
const wallet_test_vectors_1 = require("./wallet-test-vectors");
/**
 * Probe: how long UniSat's update modal gets to appear. It shows when UniSat's
 * wallet API answers a version above the pinned build; long enough for that
 * answer to arrive on the first open.
 */
const UNISAT_UPDATE_NAG_PROBE_MS = 2_000;
/**
 * Probe: how long an onboarding step that only some address types or
 * releases show (the address-type card, the compatibility notice) gets to
 * render.
 */
const UNISAT_OPTIONAL_STEP_PROBE_MS = 5_000;
/**
 * Probe: how long the address-type Continue button gets to render. Absent
 * when UniSat skips the picker; it renders after the mnemonic import settles,
 * which takes longer than the other optional steps.
 */
const UNISAT_ADDRESS_TYPE_CONTINUE_PROBE_MS = 10_000;
/**
 * Dismiss UniSat's "a new version is available" modal.
 *
 * UniSat asks its wallet API whether a newer build exists, and the modal
 * appears on the first dashboard open whenever the answer is above the pinned
 * build. `installUnisatOfflineRoutes` answers with the captured config
 * (version 1.7.19 against the pinned 1.7.15), so under the shield it shows on
 * every onboarding. It is layered ABOVE the compatibility notice: Playwright
 * reports the notice checkbox as visible, enabled and stable while
 * `.row-container` from `.popover-container` intercepts every click, so the
 * failure would name the checkbox and not the thing covering it.
 *
 * The modal carries no data-testid, so it is anchored on the one string only
 * it contains; "Skip" alone would also match the notice below it.
 */
async function dismissUnisatUpdateNag(page) {
    const modal = page.locator('.popover-container').filter({ hasText: 'Go to update' });
    if (!(await (0, is_visible_within_1.isVisibleWithin)(modal, UNISAT_UPDATE_NAG_PROBE_MS)))
        return;
    await dismissUnisatUpdateNagControls({ skip: modal.getByText('Skip', { exact: true }), modal });
}
/** The update modal's steps once it shows: Skip, then the modal is gone. */
async function dismissUnisatUpdateNagControls(c) {
    await c.skip.click();
    await c.modal.waitFor({ state: 'hidden' });
}
/**
 * Dismiss the "Compatibility Tips" notice ("Please be aware that: For Ordinals
 * assets, Rare sats are not supported.") UniSat 1.7.15 shows over the home
 * screen after onboarding. Returns whether it was there.
 *
 * It showed on every onboarding of all four address types under
 * `installUnisatOfflineRoutes`; the probe stays because what decides it is
 * UniSat's, not ours.
 */
async function dismissUnisatNotice(page) {
    const checkbox = page.getByTestId('notice-checkbox-1');
    if (!(await (0, is_visible_within_1.isVisibleWithin)(checkbox, UNISAT_OPTIONAL_STEP_PROBE_MS)))
        return false;
    const ok = page.getByTestId('notice-ok-button');
    await dismissUnisatNoticeControls({ checkbox, okReady: ok.filter({ hasText: /^\s*OK\s*$/ }), ok });
    return true;
}
/**
 * The notice's steps once it shows. OK counts down ("OK (3s)", "OK (2s)", ...)
 * and ignores clicks until its label is plain "OK", so `okReady` is OK carrying
 * exactly that label: the state in which it takes the click. Then the notice
 * is gone, or this fails naming OK rather than a later click it would cover.
 */
async function dismissUnisatNoticeControls(c) {
    await c.checkbox.click();
    await c.okReady.waitFor({ state: 'visible' });
    await c.okReady.click();
    await c.ok.waitFor({ state: 'hidden' });
}
/**
 * Drive UniSat onboarding from the BIP-39 test seed to the home tab.
 * Shared by the e2e specs AND the local wallet-runner (matches
 * onboard-okx.ts / onboard-phantom.ts / onboard-cat21wallet.ts).
 *
 * `addressTypeIndex` folds in the matrix variant: when set, the matching
 * address-type card is picked before continuing. UniSat is mainnet-only, so
 * roundtrip specs derive the regtest bcrt1 equivalents from the same pubkey.
 */
async function onboardUnisat(page, extensionId, opts = {}) {
    const password = opts.password ?? wallet_test_vectors_1.PASSWORD_BY_WALLET.unisat;
    const words = opts.mnemonicWords ?? wallet_test_vectors_1.TEST_MNEMONIC_WORDS;
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });
    await (0, test_1.expect)(page.getByTestId('welcome-title')).toBeVisible();
    await page.getByTestId('import-wallet-button').click();
    await (0, test_1.expect)(page.getByTestId('create-password-input')).toBeVisible();
    await page.getByTestId('create-password-input').fill(password);
    await page.getByTestId('create-password-confirm-input').fill(password);
    await page.getByTestId('create-password-continue-button').click();
    await (0, test_1.expect)(page.getByTestId('restore-wallet-type-option-0')).toBeVisible();
    await page.getByTestId('restore-wallet-type-option-0').click();
    await (0, test_1.expect)(page.getByTestId('mnemonic-import-word-0')).toBeVisible();
    for (let i = 0; i < words.length; i++) {
        await page.getByTestId(`mnemonic-import-word-${i}`).fill(words[i]);
    }
    await page.getByTestId('mnemonic-import-continue-button').click();
    if (opts.addressTypeIndex !== undefined) {
        const card = page.getByTestId(`address-type-card-${opts.addressTypeIndex}`);
        if (await (0, is_visible_within_1.isVisibleWithin)(card, UNISAT_OPTIONAL_STEP_PROBE_MS)) {
            // A swallowed click here does not fail: onboarding continues with the
            // DEFAULT card selected and the wallet ends up on the wrong address
            // type, which surfaces much later as a spec asserting a bc1p address
            // against a bc1q one. Selecting is idempotent, so re-clicking is safe.
            const { clicks, observable, selected } = await (0, select_card_1.selectCard)(card);
            if (clicks > 1 || !observable || selected !== true) {
                console.log(`[onboard-unisat] address-type card ${opts.addressTypeIndex}: ` +
                    `${clicks} click(s), marker ${observable ? 'readable' : 'NOT readable'}, ` +
                    `selected=${String(selected)}`);
            }
        }
    }
    const addressTypeContinue = page.getByTestId('address-type-continue-button');
    if (await (0, is_visible_within_1.isVisibleWithin)(addressTypeContinue, UNISAT_ADDRESS_TYPE_CONTINUE_PROBE_MS)) {
        await addressTypeContinue.click();
    }
    // The update modal is layered above the compatibility notice and swallows
    // every click meant for it, so it goes first.
    await dismissUnisatUpdateNag(page);
    await dismissUnisatNotice(page);
    await (0, test_1.expect)(page.getByTestId('tab-home')).toBeVisible();
    await waitForUnisatInstallTabSettled(page, extensionId);
}
/**
 * Wait until UniSat's install tab can no longer reject an approval: it has
 * booted past its root route, or the wallet will never open it.
 *
 * On a fresh install the background opens `index.html` in a new tab once its
 * own initialisation is done. That tab boots through the root route, which
 * rejects any pending approval when it is not the notification window
 * (`BoostScreen`: `isNotification || rejectApproval()`), so the approval popup
 * closes and the dapp gets 4001 "User rejected the request". The tab arrives
 * on the wallet's schedule, not onboarding's, and sometimes not at all: when
 * Chrome's `onInstalled` reaches the worker before the wallet has registered
 * its listener, the wallet never opens it (`unisat-install-tab.ts` has the
 * mechanism). Both outcomes are settled. A tab still on its root route, a
 * background that has not finished initialising, or one whose next poll may
 * still open the tab, is not.
 *
 * Needs the wallet's offline routes (`installUnisatOfflineRoutes`,
 * `installWizzOfflineRoutes`) on the context from launch: they record when the
 * background finished initialising. Without them this fails in state
 * `background-initialising`.
 */
async function waitForUnisatInstallTabSettled(onboardPage, extensionId) {
    const context = onboardPage.context();
    await test_1.expect
        .poll(() => (0, unisat_install_tab_1.installTabState)({
        extensionId,
        otherPageUrls: context.pages().filter((p) => p !== onboardPage).map((p) => p.url()),
        initialisedAt: (0, unisat_install_tab_1.walletBackgroundInitialisedAt)(context),
        now: Date.now(),
    }), { message: 'UniSat install tab neither booted past its root route nor stayed away after the background initialised' })
        .toMatch(new RegExp(`^(${unisat_install_tab_1.INSTALL_TAB_SETTLED.join('|')})$`));
}
//# sourceMappingURL=onboard-unisat.js.map