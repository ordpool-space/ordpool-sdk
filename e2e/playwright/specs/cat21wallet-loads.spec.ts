import { test, expect, chromium, BrowserContext } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 1 of the Cat21 Wallet E2E pipeline.
 *
 * Cat21 Wallet is OUR wallet (ordpool-space/cat21-wallet), forked
 * from Leather. It earns the same Pipeline B coverage as Xverse:
 * loads → onboard → sdk-handshake → mint-roundtrip. This file is
 * the entry point — proves we can load the built extension into a
 * headed Chromium in CI and read back basic facts.
 *
 * Same scaffolding as leather-loads (the upstream we forked from);
 * manifest layout is identical:
 *  - `index.html` as the options page (`open_in_tab: true`) — the
 *    full-screen onboarding/dashboard surface
 *  - `action-popup.html` as the toolbar popup
 *  - MV3 `background.js` service worker
 *
 * Cat21 Wallet ships at the canonical `window.Cat21Provider` slot
 * with `isCat21: true` (per INTEGRATION-ORDPOOL-SDK.md in the
 * wallet repo). The signer adapter (`cat21wallet.signer.ts`)
 * follows the "WE finalize, WE broadcast" convention.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/cat21wallet');

let context: BrowserContext;
let extensionId: string;
let manifestVersion: string;

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(
      `Cat21 Wallet extension not unpacked at ${EXT_PATH}. ` +
      `Run e2e/playwright/playwright-bootstrap.sh cat21wallet first.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'manifest.json'), 'utf8'));
  manifestVersion = manifest.version;
  console.log(`[cat21wallet] loading extension v${manifestVersion} from ${EXT_PATH}`);

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  }
  extensionId = worker.url().split('/')[2];
  console.log(`[cat21wallet] service worker URL = ${worker.url()}`);
  console.log(`[cat21wallet] extension id = ${extensionId}`);
});

test.afterAll(async () => {
  await context?.close();
});

test('Cat21 Wallet loads in Chromium, exposes a service worker, and renders its index entry point', async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);

  const startupPages = context.pages();
  console.log(`[cat21wallet] startup pages: ${startupPages.map(p => p.url()).join(', ')}`);

  for (const [i, p] of startupPages.entries()) {
    try {
      await p.screenshot({
        path: path.resolve(__dirname, `../../../test-results/cat21wallet-startup-page-${i}.png`),
        fullPage: true,
      });
    } catch (e) {
      console.log(`[cat21wallet] couldn't screenshot startup page ${i}: ${(e as Error).message}`);
    }
  }

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`, {
    waitUntil: 'domcontentloaded',
  });

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
    console.log('[cat21wallet] networkidle timed out, continuing with whatever rendered');
  });

  const finalUrl = page.url();
  const title = await page.title();
  console.log(`[cat21wallet] navigated URL = ${finalUrl}`);
  console.log(`[cat21wallet] page title    = ${title}`);

  await page.screenshot({
    path: path.resolve(__dirname, '../../../test-results/cat21wallet-index.png'),
    fullPage: true,
  });

  const bodyHtml = await page.evaluate(() => document.body.innerHTML.slice(0, 4000));
  fs.writeFileSync(
    path.resolve(__dirname, '../../../test-results/cat21wallet-body-snippet.html'),
    bodyHtml,
  );

  // Poll for non-empty text — React mount races against an
  // immediate innerText read after networkidle. Same flake-prone
  // pattern as the original unisat-loads (fixed in c5c65d2).
  await expect(page.locator('body')).toBeVisible();
  await page.waitForFunction(
    () => (document.body.innerText || '').trim().length > 0,
    undefined,
    { timeout: 10_000 },
  );
  const visibleText = await page.locator('body').innerText().catch(() => '');
  console.log(`[cat21wallet] visible body text (first 500 chars): ${visibleText.slice(0, 500)}`);
  expect(visibleText.length).toBeGreaterThan(0);
});
