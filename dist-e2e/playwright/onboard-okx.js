"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardOkx = onboardOkx;
const test_1 = require("@playwright/test");
const e2e_timeout_1 = require("../e2e-timeout");
const is_visible_within_1 = require("./is-visible-within");
const wallet_test_vectors_1 = require("./wallet-test-vectors");
const cdp_click_1 = require("./cdp-click");
const approval_popup_1 = require("./approval-popup");
/**
 * Probe: how long an optional step (the Next button, the password form) gets
 * to render. Some OKX releases skip it; long enough for the iframe to render
 * it on a loaded runner.
 */
const OKX_OPTIONAL_STEP_PROBE_MS = 10_000;
/**
 * Probes: how long the "Start your Web3 journey" button gets, first on the
 * page and then inside its iframe. Where it renders differs by release, and
 * some releases go straight to the dashboard.
 */
const OKX_START_BUTTON_PROBE_MS = 5_000;
const OKX_START_BUTTON_IFRAME_PROBE_MS = 3_000;
/**
 * Drive OKX v4.1.0 onboarding from welcome to dashboard. Multi-page,
 * multi-iframe flow (CI iterations 22-31, 2026-05-31):
 *   - Welcome: "Your portal to Web3" → Import wallet (CDP click +
 *     programmatic fallback; native click absorbed by anti-bot).
 *   - "Seed phrase or private key" picker on the same page.
 *   - 12-box seed form opens in #ui-ses-iframe; Confirm.
 *   - "Secure your wallet" opens on a NEW page; Password preselected;
 *     Next button (also in iframe).
 *   - "Set password" form inside the same iframe; Confirm.
 *   - "Welcome to OKX Wallet — Let's explore Web3" gate; Start your
 *     Web3 journey button.
 *
 * Requires the context to be launched with
 * `--disable-blink-features=AutomationControlled` so navigator.webdriver
 * is hidden — without this the welcome-screen click is absorbed.
 */
async function onboardOkx(page, extensionId, opts = {}) {
    const password = opts.password ?? wallet_test_vectors_1.PASSWORD_BY_WALLET.okx;
    const mnemonicWords = (opts.mnemonicWords ?? wallet_test_vectors_1.TEST_MNEMONIC_WORDS.join(' ')).split(' ');
    const mnemonic = mnemonicWords.join(' ');
    if (page.url() === 'about:blank') {
        await page.setViewportSize({ width: 400, height: 800 });
        await page.goto(`chrome-extension://${extensionId}/popup-init.html`, { waitUntil: 'domcontentloaded' });
    }
    // Wait for the cover-video opacity gate to release.
    await page.waitForFunction(() => {
        const wrapper = document.querySelector('[class*="_affix_"]');
        return !!wrapper && getComputedStyle(wrapper).opacity === '1';
    }, undefined, { polling: 250 });
    const importBtn = page.getByTestId('onboard-page-import-wallet-button');
    await (0, test_1.expect)(importBtn).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await (0, cdp_click_1.cdpClick)(page, importBtn, 'the OKX import-wallet button');
    await importBtn.click({ force: true, delay: 100 }).catch(() => undefined);
    // Deliberately INSTANT: this asks whether the click failed to navigate, so
    // the answer is about the DOM as it stands now. Waiting would mean waiting
    // for the old page to reappear, which is not a thing that happens.
    const stillOnWelcome = await page.locator('text="Your portal to Web3"').isVisible().catch(() => false);
    if (stillOnWelcome) {
        await page.evaluate(() => {
            const btn = document.querySelector('[data-testid="onboard-page-import-wallet-button"]');
            btn?.click();
        });
    }
    const seedOption = page.getByText('Seed phrase or private key', { exact: true });
    await (0, test_1.expect)(seedOption).toBeVisible();
    await (0, cdp_click_1.cdpClick)(page, seedOption, 'the OKX seed-phrase option');
    // Seed form inside #ui-ses-iframe.
    const seedFrame = page.frameLocator('#ui-ses-iframe');
    await (0, test_1.expect)(seedFrame.locator('text="My seed phrase has"').first()).toBeVisible();
    const mnemonicInputs = seedFrame.locator('input');
    await (0, test_1.expect)(mnemonicInputs.first()).toBeVisible();
    const inputCount = await mnemonicInputs.count();
    if (inputCount >= 12) {
        for (let i = 0; i < mnemonicWords.length; i++) {
            await mnemonicInputs.nth(i).fill(mnemonicWords[i]);
        }
    }
    else {
        await mnemonicInputs.first().fill(mnemonic);
    }
    const confirmAfterMnemonic = seedFrame.getByRole('button', { name: /^(confirm|continue|next|import|restore)$/i }).first();
    await (0, test_1.expect)(confirmAfterMnemonic).toBeEnabled();
    await confirmAfterMnemonic.click();
    // "Secure your wallet" is drawn inside #ui-ses-iframe (the page body stays
    // empty), on whichever extension page OKX routes to it.
    const ctx = page.context();
    page = await (0, approval_popup_1.waitForPageShowing)({ context: ctx, text: /Secure your wallet/i, frame: '#ui-ses-iframe' });
    const secureFrame = page.frameLocator('#ui-ses-iframe');
    const nextBtn = secureFrame.getByRole('button', { name: /^next$/i }).first();
    if (await (0, is_visible_within_1.isVisibleWithin)(nextBtn, OKX_OPTIONAL_STEP_PROBE_MS)) {
        await (0, test_1.expect)(nextBtn).toBeEnabled();
        await nextBtn.click();
    }
    const pwInputs = secureFrame.locator('input[type="password"]');
    if (await (0, is_visible_within_1.isVisibleWithin)(pwInputs.first(), OKX_OPTIONAL_STEP_PROBE_MS)) {
        const pwCount = await pwInputs.count();
        for (let i = 0; i < pwCount; i++) {
            await pwInputs.nth(i).fill(password);
        }
        const pwContinue = secureFrame.getByRole('button', { name: /^(confirm|continue|next|create|done)$/i }).first();
        await (0, test_1.expect)(pwContinue).toBeEnabled();
        await pwContinue.click();
    }
    // The "Welcome to OKX Wallet" completion gate, drawn in the page itself, or
    // the wallet home ("Account 01") when OKX skips the gate, which it does on
    // some runs.
    page = await (0, approval_popup_1.waitForPageShowing)({ context: ctx, text: /Welcome to OKX Wallet|Start your Web3 journey|Account 01/i });
    const startBtn = page.getByRole('button', { name: /Start your Web3 journey/i }).first();
    if (await (0, is_visible_within_1.isVisibleWithin)(startBtn, OKX_START_BUTTON_PROBE_MS)) {
        await startBtn.click().catch(() => undefined);
    }
    else {
        const fr = page.frameLocator('#ui-ses-iframe');
        const frStart = fr.getByRole('button', { name: /Start your Web3 journey/i }).first();
        if (await (0, is_visible_within_1.isVisibleWithin)(frStart, OKX_START_BUTTON_IFRAME_PROBE_MS)) {
            await frStart.click().catch(() => undefined);
        }
    }
    // A Node loop over every page's text, not a Playwright wait, so it stops at
    // the global bound.
    const dashBoundMs = (0, e2e_timeout_1.e2eTimeoutMs)();
    const dashDeadline = Date.now() + dashBoundMs;
    let dashed = false;
    while (Date.now() < dashDeadline) {
        for (const p of ctx.pages()) {
            const text = (await p.locator('body').innerText().catch(() => '')).toLowerCase();
            if (text.includes('send') || text.includes('receive') || text.includes('balance') ||
                text.includes('total') || text.includes('welcome to okx wallet') ||
                text.includes('start your web3 journey') || text.includes('tokens') || text.includes('nft')) {
                dashed = true;
                page = p;
                break;
            }
        }
        if (dashed)
            break;
        await new Promise(r => setTimeout(r, 500));
    }
    if (!dashed)
        throw new Error(`OKX dashboard markers not found on any context page within ${dashBoundMs}ms`);
    return page;
}
//# sourceMappingURL=onboard-okx.js.map