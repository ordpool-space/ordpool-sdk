"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardLeather = onboardLeather;
const test_1 = require("@playwright/test");
const wallet_test_vectors_1 = require("./wallet-test-vectors");
/**
 * Drive a Leather-family wallet through onboarding from the BIP-39 test seed to
 * a signed-in dashboard: welcome → "Use existing key" → 12 per-word seed inputs
 * → set password → dashboard (send/receive/balance/bitcoin).
 *
 * Leather AND its fork Cat21 Wallet share this exact flow (identical bundle
 * testids: `sign-in-link`, `set-or-enter-password-input`, `set-password-btn`),
 * so onboard-cat21wallet.ts delegates here. Shared by the e2e specs + the local
 * wallet-runner (matches onboard-okx.ts / onboard-phantom.ts).
 */
async function onboardLeather(page, extensionId, opts = {}) {
    const password = opts.password ?? wallet_test_vectors_1.PASSWORD_BY_WALLET.leather;
    const mnemonic = opts.mnemonic ?? wallet_test_vectors_1.TEST_MNEMONIC;
    await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });
    await (0, test_1.expect)(page.getByTestId('sign-in-link')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('sign-in-link').click();
    const inputs = page.locator('input[type="text"], input[type="password"]');
    await (0, test_1.expect)(inputs.first()).toBeVisible({ timeout: 15_000 });
    const words = mnemonic.split(' ');
    for (let i = 0; i < words.length; i++)
        await inputs.nth(i).fill(words[i]);
    await page.getByRole('button', { name: /continue|sign in|restore|confirm/i }).first().click();
    const pwInput = page.getByTestId('set-or-enter-password-input');
    await (0, test_1.expect)(pwInput).toBeVisible({ timeout: 15_000 });
    await pwInput.click();
    await pwInput.pressSequentially(password, { delay: 15 });
    await page.getByTestId('set-password-btn').click();
    await page.waitForFunction(() => {
        const t = (document.body.innerText || '').toLowerCase();
        return t.includes('send') || t.includes('receive') || t.includes('balance') || t.includes('bitcoin');
    }, undefined, { timeout: 30_000, polling: 250 });
}
//# sourceMappingURL=onboard-leather.js.map