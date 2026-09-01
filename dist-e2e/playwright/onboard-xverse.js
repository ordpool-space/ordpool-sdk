"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardXverse = onboardXverse;
exports.primeAndSwitchToRegtest = primeAndSwitchToRegtest;
exports.overrideRegtestElectrsUrl = overrideRegtestElectrsUrl;
const test_1 = require("@playwright/test");
const wallet_test_vectors_1 = require("./wallet-test-vectors");
async function nextPostMnemonicState(page) {
    const handle = await page.waitForFunction(() => {
        const t = (document.body.innerText || '').toLowerCase();
        if (t.includes('wallet restored'))
            return 'restored';
        if (t.includes('preferred address type'))
            return 'address-type';
        if (t.includes('select a wallet to restore') || t.includes('we found funds'))
            return 'picker';
        return false;
    }, undefined, { timeout: 120_000, polling: 250 });
    return handle.jsonValue();
}
async function clickAndAwaitTransition(page, buttonText, sentinelGoneRegex, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        await page.waitForFunction((label) => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.some(el => {
                if (el.textContent?.trim() !== label)
                    return false;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0)
                    return false;
                const style = getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none')
                    return false;
                if (el.hasAttribute('disabled'))
                    return false;
                if (style.pointerEvents === 'none')
                    return false;
                return true;
            });
        }, buttonText, { timeout: 30_000, polling: 250 });
        const btn = page.getByRole('button', { name: buttonText, exact: true }).first();
        await (0, test_1.expect)(btn).toBeVisible({ timeout: 5_000 });
        await btn.click();
        const transitioned = await page.waitForFunction((re) => !(new RegExp(re, 'i')).test(document.body.innerText || ''), sentinelGoneRegex.source, { timeout: 5_000, polling: 250 }).then(() => true).catch(() => false);
        if (transitioned)
            return;
    }
    throw new Error(`"${buttonText}" did not transition past "${sentinelGoneRegex}" after ${attempts} attempts`);
}
/** Drive Xverse onboarding from the BIP-39 test seed to a restored wallet. */
async function onboardXverse(context, extensionId, opts = {}) {
    const password = opts.password ?? wallet_test_vectors_1.PASSWORD_BY_WALLET.xverse;
    const mnemonic = opts.mnemonic ?? wallet_test_vectors_1.TEST_MNEMONIC;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
        const t = (document.body.innerText || '').toLowerCase();
        return t.includes('restore') && t.includes('create');
    }, undefined, { timeout: 30_000 });
    await page.getByText(/restore an existing wallet|restore.*wallet/i).first().click();
    await (0, test_1.expect)(page.getByText(/legal/i).first()).toBeVisible({ timeout: 15_000 });
    const dc = page.getByText(/authorize data collection/i).first();
    if (await dc.isVisible({ timeout: 3_000 }).catch(() => false))
        await dc.click();
    await page.getByRole('button', { name: /^accept$/i }).first().click();
    const pws = page.locator('input[type="password"]');
    await (0, test_1.expect)(pws.first()).toBeVisible({ timeout: 15_000 });
    const pwCount = await pws.count();
    for (let i = 0; i < pwCount; i++)
        await pws.nth(i).fill(password);
    await page.getByRole('button', { name: /continue|next|confirm|done|create/i }).first().click();
    await (0, test_1.expect)(page.getByText(/restore your wallet|what wallet are you importing/i).first()).toBeVisible({ timeout: 15_000 });
    await page.getByText(/^xverse$/i).first().click();
    await (0, test_1.expect)(page.getByText(/enter seed phrase/i).first()).toBeVisible({ timeout: 15_000 });
    const seedInputs = page.locator('input[type="password"]');
    await (0, test_1.expect)(seedInputs.first()).toBeVisible({ timeout: 10_000 });
    await seedInputs.first().click();
    await seedInputs.first().pressSequentially(mnemonic, { delay: 25 });
    await page.getByRole('button', { name: /continue|next|restore|confirm|done/i }).first().click();
    const seen = new Set();
    for (;;) {
        const state = await nextPostMnemonicState(page);
        if (state === 'restored')
            break;
        if (seen.has(state))
            throw new Error(`stuck in post-mnemonic state: ${state}`);
        seen.add(state);
        if (state === 'picker') {
            await page.getByRole('button', { name: /see accounts/i }).first().click();
            await clickAndAwaitTransition(page, 'Confirm', /select a wallet to restore|we found funds/i);
        }
        else if (state === 'address-type') {
            await clickAndAwaitTransition(page, 'Continue', /preferred address type/i);
        }
    }
}
/** Switch a just-onboarded Xverse to Bitcoin Regtest (Testnet mode + Regtest). */
async function primeAndSwitchToRegtest(context, extensionId) {
    const primer = await context.newPage();
    await primer.setViewportSize({ width: 400, height: 800 });
    await primer.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    // 60s, not 30s: the wallet matrix runs several extension jobs in parallel on
    // shared CI runners, so Xverse's popup can be slow to hydrate here — it flaked
    // on a 30s ceiling once under matrix load.
    await primer.waitForFunction(() => {
        const t = (document.body.innerText || '').toLowerCase();
        return t.includes('account 1') || t.includes('not now') || t.includes('zest');
    }, undefined, { timeout: 60_000, polling: 250 });
    const notNow = primer.getByText('Not now', { exact: true }).first();
    if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await notNow.click({ force: true }).catch(() => undefined);
    }
    await primer.goto(`chrome-extension://${extensionId}/popup.html#/settings/change-network`, { waitUntil: 'domcontentloaded' });
    await primer.waitForFunction(() => /testnet mode/i.test(document.body.innerText || ''), undefined, { timeout: 15_000 });
    // Toggle Testnet mode via a DOM-relative locator (no coordinate clicks —
    // E2E_BEST_PRACTICES). Scope the switch to the settings row that holds the
    // "Testnet mode" label so we never flip an unrelated control; fall back to the
    // single switch on the change-network page if the row scoping finds none.
    const rowSwitch = primer
        .getByText('Testnet mode', { exact: true })
        .locator('xpath=ancestor-or-self::*[.//*[@role="switch"] or .//*[@role="checkbox"] or .//input[@type="checkbox"]][1]')
        .locator('[role="switch"], [role="checkbox"], input[type="checkbox"]')
        .first();
    const pageSwitch = primer.locator('[role="switch"], [role="checkbox"], input[type="checkbox"]').first();
    const testnetToggle = (await rowSwitch.count()) > 0 ? rowSwitch : pageSwitch;
    await (0, test_1.expect)(testnetToggle).toBeVisible({ timeout: 10_000 });
    await testnetToggle.click({ force: true });
    await primer.waitForFunction(() => {
        const txt = document.body.innerText || '';
        return /testnet/i.test(txt) && /BITCOIN[\s\S]{0,80}testnet/i.test(txt);
    }, undefined, { timeout: 10_000, polling: 250 });
    await primer.getByText('Regtest', { exact: true }).first().click({ force: true });
    // Verify the switch actually took. A failed network switch must surface HERE,
    // not downstream as a mystery zero-balance — throw a clear error if the popup
    // never reflects BITCOIN → Regtest.
    await primer.waitForFunction(() => /BITCOIN[\s\S]{0,40}\bRegtest\b/.test(document.body.innerText || ''), undefined, { timeout: 10_000, polling: 250 }).catch(() => {
        throw new Error('Xverse Regtest switch not verified: popup never showed BITCOIN → Regtest');
    });
}
/**
 * Override the built-in Regtest network's electrsApiUrl so Xverse broadcasts to
 * our local electrs instead of the default sBTC mempool. Xverse stores networks
 * in chrome.storage.local under `persistentStore::networks` as JSON.
 */
async function overrideRegtestElectrsUrl(context, extensionId, electrsUrl) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async ([key, url]) => {
        const c = window.chrome;
        const current = await new Promise(r => c.storage.local.get(key, r));
        const raw = current[key];
        if (!raw)
            throw new Error(`${key} not in chrome.storage.local`);
        const parsed = JSON.parse(raw);
        const target = parsed.value.configurations.find(cfg => cfg.id === 'bitcoin-regtest');
        if (!target)
            throw new Error('bitcoin-regtest not in configurations');
        target.electrsApiUrl = url;
        await new Promise(r => c.storage.local.set({ [key]: JSON.stringify(parsed) }, r));
    }, ['persistentStore::networks', electrsUrl]);
    await page.close();
}
//# sourceMappingURL=onboard-xverse.js.map