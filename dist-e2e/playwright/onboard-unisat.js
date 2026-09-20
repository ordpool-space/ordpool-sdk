"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardUnisat = onboardUnisat;
const test_1 = require("@playwright/test");
const is_visible_within_1 = require("./is-visible-within");
const select_card_1 = require("./select-card");
const wallet_test_vectors_1 = require("./wallet-test-vectors");
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
    await (0, test_1.expect)(page.getByTestId('welcome-title')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('import-wallet-button').click();
    await (0, test_1.expect)(page.getByTestId('create-password-input')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('create-password-input').fill(password);
    await page.getByTestId('create-password-confirm-input').fill(password);
    await page.getByTestId('create-password-continue-button').click();
    await (0, test_1.expect)(page.getByTestId('restore-wallet-type-option-0')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('restore-wallet-type-option-0').click();
    await (0, test_1.expect)(page.getByTestId('mnemonic-import-word-0')).toBeVisible({ timeout: 15_000 });
    for (let i = 0; i < words.length; i++) {
        await page.getByTestId(`mnemonic-import-word-${i}`).fill(words[i]);
    }
    await page.getByTestId('mnemonic-import-continue-button').click();
    if (opts.addressTypeIndex !== undefined) {
        const card = page.getByTestId(`address-type-card-${opts.addressTypeIndex}`);
        if (await (0, is_visible_within_1.isVisibleWithin)(card, 5_000)) {
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
    if (await (0, is_visible_within_1.isVisibleWithin)(addressTypeContinue, 10_000)) {
        await addressTypeContinue.click();
    }
    // Unisat shows an acknowledgement notice for SOME address types (nested
    // segwit and taproot) and none for others, so this branch runs on some runs
    // and not others.
    //
    // Dismissing it is BEST EFFORT on purpose: the notice does not stand between
    // the wallet and its home screen, and its checkbox is an Ant-Design control
    // whose input refuses a direct click (`pointer-events` suppressed on the
    // hidden box — the same quirk the wizz helper documents for its fork of this
    // UI). Nothing is swallowed by doing so: the `tab-home` assertion below is
    // what proves onboarding finished, so a notice that genuinely blocked would
    // still fail there, naming the screen rather than a checkbox.
    const noticeCheckbox = page.getByTestId('notice-checkbox-1');
    if (await (0, is_visible_within_1.isVisibleWithin)(noticeCheckbox, 5_000)) {
        await noticeCheckbox.click({ timeout: 5_000 }).catch(() => undefined);
        const noticeOk = page.getByTestId('notice-ok-button');
        if (await noticeOk.isEnabled().catch(() => false)) {
            await noticeOk.click({ timeout: 5_000 }).catch(() => undefined);
        }
    }
    await (0, test_1.expect)(page.getByTestId('tab-home')).toBeVisible({ timeout: 30_000 });
}
//# sourceMappingURL=onboard-unisat.js.map