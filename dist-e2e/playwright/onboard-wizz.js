"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardWizz = onboardWizz;
exports.continueAfterAddressType = continueAfterAddressType;
const e2e_expect_1 = require("./e2e-expect");
const cdp_click_1 = require("./cdp-click");
const click_until_effect_1 = require("./click-until-effect");
const onboard_unisat_1 = require("./onboard-unisat");
const wallet_test_vectors_1 = require("./wallet-test-vectors");
/**
 * Drive Wizz (a UniSat fork) onboarding from the BIP-39 test seed to the
 * dashboard. Wizz's onboarding has NO data-testids, so this uses text + role
 * selectors. `addressTypeRowLabel` folds in the matrix variant (default Native
 * Segwit). Wizz is mainnet-only; roundtrip specs derive the regtest bcrt1
 * equivalents. Shared by the e2e specs + the local wallet-runner.
 */
async function onboardWizz(page, extensionId, opts = {}) {
    (0, e2e_expect_1.boundByE2eTimeout)(page);
    const password = opts.password ?? wallet_test_vectors_1.PASSWORD_BY_WALLET.wizz;
    const words = opts.mnemonicWords ?? wallet_test_vectors_1.TEST_MNEMONIC_WORDS;
    const addressTypeRowLabel = opts.addressTypeRowLabel ?? 'Native Segwit (P2WPKH)';
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });
    await (0, e2e_expect_1.e2eExpect)(page.getByText('I already have a wallet', { exact: true })).toBeVisible();
    await page.getByText('I already have a wallet', { exact: true }).click();
    const pwInputs = page.locator('input[type="password"]');
    await (0, e2e_expect_1.e2eExpect)(pwInputs.first()).toBeVisible();
    const pwCount = await pwInputs.count();
    for (let i = 0; i < pwCount; i++)
        await pwInputs.nth(i).fill(password);
    await (0, click_until_effect_1.clickUntilEffect)(page.getByRole('button', { name: /^continue$/i }).first(), page.getByText('Wizz Wallet', { exact: true }).first(), { label: 'wizz onboarding: continue after password' });
    // The "Wizz Wallet" source button pulses (`button-pulse`: an endless
    // transform: scale(0.98 -> 1) animation, no reduced-motion variant), so it
    // is never "stable" and a Playwright click waits on it until the bound. A
    // real mouse click at its centre lands regardless of the scale, which is
    // what `cdpClick` sends; the mnemonic form appearing is the proof it landed.
    await (0, cdp_click_1.cdpClick)(page, page.getByRole('button', { name: 'Wizz Wallet', exact: true }), 'the "Wizz Wallet" restore source');
    const mnemonicInputs = page.locator('input[type="text"], input[type="password"]');
    await (0, e2e_expect_1.e2eExpect)(mnemonicInputs.first()).toBeVisible();
    for (let i = 0; i < words.length; i++)
        await mnemonicInputs.nth(i).fill(words[i]);
    await (0, click_until_effect_1.clickUntilEffect)(page.getByRole('button', { name: /^continue$/i }).first(), page.getByText(addressTypeRowLabel, { exact: true }).first(), { label: 'wizz onboarding: continue after mnemonic' });
    await (0, e2e_expect_1.e2eExpect)(page.getByText(addressTypeRowLabel, { exact: true }).first()).toBeVisible();
    await page.getByText(addressTypeRowLabel, { exact: true }).first().click();
    await continueAfterAddressType(page, 'wizz onboarding: continue after address type');
    await (0, e2e_expect_1.e2eExpect)(page.getByText('Security Tips', { exact: true })).toBeVisible();
    const checkboxes = page.locator('label.ant-checkbox-wrapper');
    await (0, e2e_expect_1.e2eExpect)(checkboxes).toHaveCount(3);
    const cbCount = await checkboxes.count();
    for (let i = 0; i < cbCount; i++)
        await checkboxes.nth(i).click();
    await page.getByRole('button', { name: /^ok$/i }).click();
    await page.waitForFunction(() => {
        const t = (document.body.innerText || '').toLowerCase();
        return t.includes('receive') || t.includes('send') || t.includes('balance');
    }, undefined, { polling: 500 });
    // Wizz is a UniSat fork and opens the same install tab once its background
    // has initialised, on its own schedule, sometimes after onboarding has
    // returned, and sometimes never. Its boot rejects a pending approval that is
    // not the notification window, so a connect sent before it booted fails with
    // 4001 "User rejected the request".
    await (0, onboard_unisat_1.waitForUnisatInstallTabSettled)(page, extensionId);
}
/**
 * Click Continue on the address-type step until Security Tips shows.
 *
 * A Continue click there can first make Wizz derive the account's addresses
 * (the button shows ant-design's loading icon, the rows fill in) and leave the
 * step on screen, so a second click is the one that advances. After the
 * loading ends, the icon can stay in the DOM in its leave animation
 * (`ant-btn-loading-icon-motion-leave`) with its `aria-label="loading"`, which
 * names the button "loading Continue" in the accessibility tree. A failure's
 * attached aria snapshot and HTML showed exactly that: the button idle (no
 * `ant-btn-loading` class) and a role locator for "Continue" matching nothing,
 * so the second click waited for the whole bound.
 *
 * The button is therefore found by its text, which the icon does not change.
 * It counts as still pre-click while it is enabled and not loading, so
 * clickUntilEffect clicks again then and otherwise waits for the effect.
 */
async function continueAfterAddressType(page, label) {
    const continueBtn = page.locator('button', { hasText: /^\s*Continue\s*$/ }).last();
    await (0, e2e_expect_1.e2eExpect)(continueBtn).toBeVisible();
    await continueBtn.scrollIntoViewIfNeeded();
    await (0, click_until_effect_1.clickUntilEffect)(continueBtn, page.getByText('Security Tips', { exact: true }), {
        label,
        stillPreClick: async () => (await continueBtn.isEnabled()) && !((await continueBtn.getAttribute('class')) ?? '').includes('ant-btn-loading'),
    });
}
//# sourceMappingURL=onboard-wizz.js.map