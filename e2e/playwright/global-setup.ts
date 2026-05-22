import { chromium, BrowserContext, Page, expect } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Playwright globalSetup — runs ONCE before any spec.
 *
 * Drives the full Xverse onboarding (BIP-39 test seed + password)
 * and switches the wallet to Bitcoin Regtest mode, then dumps the
 * extension's `chrome.storage.local` to a JSON file. Specs read
 * that file in their beforeAll and restore it into a fresh
 * Chromium context, skipping the 25s click flow per spec.
 *
 * Dump path:
 *   process.env.XVERSE_STORAGE_DUMP
 *   ?? path.resolve(__dirname, '../../test-results/xverse-storage.json')
 *
 * The test seed is the well-known BIP-39 abandon×11 + about
 * vector and the password is publicly checked into this file.
 * Both are deliberately unsuited for production use — the
 * resulting wallet is observable by anyone with the dump.
 */

const EXT_PATH = path.resolve(__dirname, '../extensions/xverse');
const DUMP_PATH = process.env.XVERSE_STORAGE_DUMP
  ?? path.resolve(__dirname, '../../test-results/xverse-storage.json');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'TestPassword123!';


type PostMnemonicState = 'picker' | 'address-type' | 'restored';

async function nextPostMnemonicState(page: Page): Promise<PostMnemonicState> {
  const handle = await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    if (t.includes('wallet restored')) return 'restored';
    if (t.includes('preferred address type')) return 'address-type';
    if (t.includes('select a wallet to restore') || t.includes('we found funds')) return 'picker';
    return false;
  }, undefined, { timeout: 120_000, polling: 250 });
  return handle.jsonValue() as Promise<PostMnemonicState>;
}

async function clickAndAwaitTransition(
  page: Page,
  buttonText: string,
  sentinelGoneRegex: RegExp,
  attempts = 3,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    await page.waitForFunction((label: string) => {
      const buttons = Array.from(document.querySelectorAll('button'));
      return buttons.some(el => {
        if (el.textContent?.trim() !== label) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        if (el.hasAttribute('disabled')) return false;
        if (style.pointerEvents === 'none') return false;
        return true;
      });
    }, buttonText, { timeout: 30_000, polling: 250 });
    const btn = page.getByRole('button', { name: buttonText, exact: true }).first();
    await expect(btn).toBeVisible({ timeout: 5_000 });
    await btn.click();
    const transitioned = await page.waitForFunction(
      (re: string) => !(new RegExp(re, 'i')).test(document.body.innerText || ''),
      sentinelGoneRegex.source,
      { timeout: 5_000, polling: 250 },
    ).then(() => true).catch(() => false);
    if (transitioned) return;
  }
  throw new Error(`"${buttonText}" did not transition past "${sentinelGoneRegex}" after ${attempts} attempts`);
}

async function onboardXverse(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('restore') && t.includes('create');
  }, undefined, { timeout: 30_000 });

  await page.getByText(/restore an existing wallet|restore.*wallet/i).first().click();
  await expect(page.getByText(/legal/i).first()).toBeVisible({ timeout: 15_000 });
  const dc = page.getByText(/authorize data collection/i).first();
  if (await dc.isVisible({ timeout: 3_000 }).catch(() => false)) await dc.click();
  await page.getByRole('button', { name: /^accept$/i }).first().click();

  const pws = page.locator('input[type="password"]');
  await expect(pws.first()).toBeVisible({ timeout: 15_000 });
  const pwCount = await pws.count();
  for (let i = 0; i < pwCount; i++) await pws.nth(i).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: /continue|next|confirm|done|create/i }).first().click();

  await expect(page.getByText(/restore your wallet|what wallet are you importing/i).first()).toBeVisible({ timeout: 15_000 });
  await page.getByText(/^xverse$/i).first().click();

  await expect(page.getByText(/enter seed phrase/i).first()).toBeVisible({ timeout: 15_000 });
  const seedInputs = page.locator('input[type="password"]');
  await expect(seedInputs.first()).toBeVisible({ timeout: 10_000 });
  await seedInputs.first().click();
  await seedInputs.first().pressSequentially(TEST_MNEMONIC, { delay: 25 });
  await page.getByRole('button', { name: /continue|next|restore|confirm|done/i }).first().click();

  const seen = new Set<PostMnemonicState>();
  for (;;) {
    const state = await nextPostMnemonicState(page);
    if (state === 'restored') break;
    if (seen.has(state)) throw new Error(`stuck in post-mnemonic state: ${state}`);
    seen.add(state);
    if (state === 'picker') {
      await page.getByRole('button', { name: /see accounts/i }).first().click();
      await clickAndAwaitTransition(page, 'Confirm', /select a wallet to restore|we found funds/i);
    } else if (state === 'address-type') {
      await clickAndAwaitTransition(page, 'Continue', /preferred address type/i);
    }
  }
}

async function primeAndSwitchToRegtest(context: BrowserContext, extensionId: string): Promise<void> {
  const primer = await context.newPage();
  await primer.setViewportSize({ width: 400, height: 800 });
  await primer.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await primer.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('account 1') || t.includes('not now') || t.includes('zest');
  }, undefined, { timeout: 30_000, polling: 250 });
  const notNow = primer.getByText('Not now', { exact: true }).first();
  if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await notNow.click({ force: true }).catch(() => undefined);
  }

  await primer.goto(`chrome-extension://${extensionId}/popup.html#/settings/change-network`, { waitUntil: 'domcontentloaded' });
  await primer.waitForFunction(() => /testnet mode/i.test(document.body.innerText || ''), undefined, { timeout: 15_000 });
  // Flip Testnet-mode toggle
  const switchEl = primer.locator('[role="switch"], [role="checkbox"], input[type="checkbox"]').first();
  if (await switchEl.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await switchEl.click({ force: true });
  } else {
    const rowBox = await primer.getByText('Testnet mode', { exact: true }).first().boundingBox();
    if (!rowBox) throw new Error('Could not locate "Testnet mode" row');
    await primer.mouse.click(rowBox.x + 320, rowBox.y + rowBox.height / 2);
  }
  await primer.waitForFunction(() => {
    const txt = document.body.innerText || '';
    return /testnet/i.test(txt) && /BITCOIN[\s\S]{0,80}testnet/i.test(txt);
  }, undefined, { timeout: 10_000, polling: 250 });
  // Pick Regtest for the Bitcoin row
  await primer.getByText('Regtest', { exact: true }).first().click({ force: true });
  await primer.waitForFunction(() => {
    return /BITCOIN[\s\S]{0,40}\bRegtest\b/.test(document.body.innerText || '');
  }, undefined, { timeout: 10_000, polling: 250 }).catch(() => undefined);
}

async function dumpStorage(context: BrowserContext, extensionId: string): Promise<Record<string, unknown>> {
  // chrome.storage.local is only available from extension-origin
  // pages. Open a fresh extension page, evaluate get(null) to grab
  // every key.
  const dumper = await context.newPage();
  await dumper.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  // Wait briefly so any async post-restore writes settle.
  await dumper.waitForTimeout(2_000);
  const data = await dumper.evaluate(() => new Promise<Record<string, unknown>>((resolve) => {
    (window as unknown as { chrome: { storage: { local: { get: (k: null, cb: (v: Record<string, unknown>) => void) => void } } } })
      .chrome.storage.local.get(null, (v) => resolve(v));
  }));
  await dumper.close();
  return data;
}

export default async function globalSetup(): Promise<void> {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Xverse extension not unpacked at ${EXT_PATH}. Run e2e/playwright/playwright-bootstrap.sh.`);
  }

  // Skip re-onboarding if the dump already exists from a previous
  // run with the same Xverse version. Saves ~25s on local re-runs.
  if (fs.existsSync(DUMP_PATH) && !process.env.XVERSE_FORCE_REONBOARD) {
    // eslint-disable-next-line no-console
    console.log(`[globalSetup] reusing existing dump at ${DUMP_PATH}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[globalSetup] onboarding Xverse + switching to Regtest…`);
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const extensionId = worker.url().split('/')[2];

  try {
    await onboardXverse(context, extensionId);
    await primeAndSwitchToRegtest(context, extensionId);
    const dump = await dumpStorage(context, extensionId);

    fs.mkdirSync(path.dirname(DUMP_PATH), { recursive: true });
    fs.writeFileSync(DUMP_PATH, JSON.stringify(dump, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[globalSetup] dumped ${Object.keys(dump).length} keys to ${DUMP_PATH}`);
  } finally {
    await context.close();
  }
}
