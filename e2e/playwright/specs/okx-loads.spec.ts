import { test, expect, chromium, BrowserContext } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 1 of the Okx E2E pipeline: prove that we can load
 * the published .crx into a headed Chromium in CI and read back
 * basic facts about the extension (its ID, manifest version,
 * entry-point screenshot, DOM snippet).
 *
 * Same scaffolding as the other *-loads specs. The mnemonic-
 * restore flow + signer wiring land in subsequent iterations,
 * informed by the screenshot + DOM snapshot this run produces.
 *
 * Entry point per manifest: `popup-init.html`.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/okx');

let context: BrowserContext;
let extensionId: string;
let manifestVersion: string;

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(
      `Okx extension not unpacked at ${EXT_PATH}. ` +
      `Run e2e/playwright/playwright-bootstrap.sh okx first.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'manifest.json'), 'utf8'));
  manifestVersion = manifest.version;
  console.log(`[okx] loading extension v${manifestVersion} from ${EXT_PATH}`);

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
  console.log(`[okx] service worker URL = ${worker.url()}`);
  console.log(`[okx] extension id = ${extensionId}`);
});

test.afterAll(async () => {
  await context?.close();
});

test('Okx loads in Chromium with a service worker registered; navigates to its entry point with non-empty body text', async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);

  const startupPages = context.pages();
  console.log(`[okx] startup pages: ${startupPages.map(p => p.url()).join(', ')}`);
  for (const [i, p] of startupPages.entries()) {
    try {
      await p.screenshot({
        path: path.resolve(__dirname, `../../../test-results/okx-startup-page-${i}.png`),
        fullPage: true,
      });
    } catch (e) {
      console.log(`[okx] couldn't screenshot startup page ${i}: ${(e as Error).message}`);
    }
  }

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup-init.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
    console.log('[okx] networkidle timed out, continuing with whatever rendered');
  });

  const finalUrl = page.url();
  const title = await page.title();
  console.log(`[okx] navigated URL = ${finalUrl}`);
  console.log(`[okx] page title    = ${title}`);

  await page.screenshot({
    path: path.resolve(__dirname, `../../../test-results/okx-index.png`),
    fullPage: true,
  });

  const bodyHtml = await page.evaluate(() => document.body.innerHTML.slice(0, 4000));
  fs.writeFileSync(
    path.resolve(__dirname, `../../../test-results/okx-body-snippet.html`),
    bodyHtml,
  );

  // Poll for non-empty body text — React mount can race against
  // networkidle (same pattern that flaked the original unisat-loads
  // and was fixed by c5c65d2).
  await expect(page.locator('body')).toBeVisible();
  await page.waitForFunction(
    () => (document.body.innerText || '').trim().length > 0,
    undefined,
    { timeout: 10_000 },
  );
  const visibleText = await page.locator('body').innerText().catch(() => '');
  console.log(`[okx] visible body text (first 500 chars): ${visibleText.slice(0, 500)}`);
  expect(visibleText.length).toBeGreaterThan(0);
});
