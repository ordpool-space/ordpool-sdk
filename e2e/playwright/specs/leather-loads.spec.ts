import { test, expect, chromium, BrowserContext } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 1 of the Leather E2E pipeline: prove that we can load
 * the published .crx into a headed Chromium in CI and read back
 * basic facts about the extension (its ID, manifest version,
 * entry-point screenshot, DOM snippet).
 *
 * Same scaffolding as xverse-loads / unisat-loads. The mnemonic-
 * restore flow lands in iteration 2 informed by the screenshot +
 * DOM snapshot this run produces.
 *
 * Leather's manifest declares:
 *  - `index.html` as the options page (`open_in_tab: true`) — the
 *    full-screen onboarding/dashboard surface
 *  - `action-popup.html` as the toolbar popup
 *  - MV3 `background.js` service worker
 *
 * The signer adapter (`leather.signer.ts`) already follows the
 * "WE finalize, WE broadcast" convention — leather is the model the
 * other wallets are migrating toward. See WALLETS.md.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/leather');

let context: BrowserContext;
let extensionId: string;
let manifestVersion: string;

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(
      `Leather extension not unpacked at ${EXT_PATH}. ` +
      `Run e2e/playwright/playwright-bootstrap.sh leather first.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'manifest.json'), 'utf8'));
  manifestVersion = manifest.version;
  console.log(`[leather] loading extension v${manifestVersion} from ${EXT_PATH}`);

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
  console.log(`[leather] service worker URL = ${worker.url()}`);
  console.log(`[leather] extension id = ${extensionId}`);
});

test.afterAll(async () => {
  await context?.close();
});

test('Leather loads in Chromium, exposes a service worker, and renders its index entry point', async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);

  const startupPages = context.pages();
  console.log(`[leather] startup pages: ${startupPages.map(p => p.url()).join(', ')}`);

  for (const [i, p] of startupPages.entries()) {
    try {
      await p.screenshot({
        path: path.resolve(__dirname, `../../../test-results/leather-startup-page-${i}.png`),
        fullPage: true,
      });
    } catch (e) {
      console.log(`[leather] couldn't screenshot startup page ${i}: ${(e as Error).message}`);
    }
  }

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`, {
    waitUntil: 'domcontentloaded',
  });

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
    console.log('[leather] networkidle timed out, continuing with whatever rendered');
  });

  const finalUrl = page.url();
  const title = await page.title();
  console.log(`[leather] navigated URL = ${finalUrl}`);
  console.log(`[leather] page title    = ${title}`);

  await page.screenshot({
    path: path.resolve(__dirname, '../../../test-results/leather-index.png'),
    fullPage: true,
  });

  const bodyHtml = await page.evaluate(() => document.body.innerHTML.slice(0, 4000));
  fs.writeFileSync(
    path.resolve(__dirname, '../../../test-results/leather-body-snippet.html'),
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
  console.log(`[leather] visible body text (first 500 chars): ${visibleText.slice(0, 500)}`);
  expect(visibleText.length).toBeGreaterThan(0);
});
