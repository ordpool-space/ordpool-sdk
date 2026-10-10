import { test, expect, chromium, BrowserContext } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 1 of the Xverse E2E pipeline: prove that we can load
 * the published .crx into a headed Chromium in CI and read back
 * basic facts about the extension (its ID, manifest version).
 *
 * No onboarding flow yet — Xverse's UI selectors are unknown
 * without first seeing the CI screenshot of whatever page renders
 * after install. The mnemonic-restore flow lands in iteration 2,
 * informed by the screenshot + DOM snapshot this run produces.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/xverse');

let context: BrowserContext;
let extensionId: string;
let manifestVersion: string;

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(
      `Xverse extension not unpacked at ${EXT_PATH}. ` +
      `This is a missing prerequisite, not a test failure: run e2e/playwright/playwright-bootstrap.sh xverse.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'manifest.json'), 'utf8'));
  manifestVersion = manifest.version;
  console.log(`[xverse] loading extension v${manifestVersion} from ${EXT_PATH}`);

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  // Manifest V3: extension registers a service worker on install.
  // Wait for it so we can read back its ID.
  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker');
  }
  // chrome-extension://<id>/<path>
  extensionId = worker.url().split('/')[2];
  console.log(`[xverse] service worker URL = ${worker.url()}`);
  console.log(`[xverse] extension id = ${extensionId}`);
});

test.afterAll(async () => {
  await context?.close();
});

test('Xverse loads in Chromium with a service worker registered; navigates to its onboarding entry point with non-empty body text', async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/); // chromium extension IDs are 32 lowercase a-p chars

  // Many extensions auto-open a tab on first install. Capture
  // whatever's there for diagnosis.
  const startupPages = context.pages();
  console.log(`[xverse] startup pages: ${startupPages.map(p => p.url()).join(', ')}`);

  for (const [i, p] of startupPages.entries()) {
    try {
      await p.screenshot({
        path: path.resolve(__dirname, `../../../test-results/xverse-startup-page-${i}.png`),
        fullPage: true,
      });
    } catch (e) {
      console.log(`[xverse] couldn't screenshot startup page ${i}: ${(e as Error).message}`);
    }
  }

  // Xverse's manifest exposes options.html / popup.html / panel.html.
  // options.html is the most likely full-page entry point for an
  // onboarding flow; popup.html is the toolbar dropdown.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`, {
    waitUntil: 'domcontentloaded',
  });

  // Wait until the extension rendered something (React mount, route
  // resolution). What it renders is unknown here, so the signal is body text.
  await page.waitForFunction(() => (document.body.innerText || '').trim().length > 0);

  const finalUrl = page.url();
  const title = await page.title();
  console.log(`[xverse] navigated URL = ${finalUrl}`);
  console.log(`[xverse] page title    = ${title}`);

  await page.screenshot({
    path: path.resolve(__dirname, '../../../test-results/xverse-index.png'),
    fullPage: true,
  });

  // Dump a chunk of the rendered DOM so the next iteration knows
  // what selectors are available.
  const bodyHtml = await page.evaluate(() => document.body.innerHTML.slice(0, 4000));
  fs.writeFileSync(
    path.resolve(__dirname, '../../../test-results/xverse-body-snippet.html'),
    bodyHtml,
  );

  // Non-empty text is the readiness signal: React mounts after the
  // document loads, so an immediate innerText read can see an empty body.
  await expect(page.locator('body')).toBeVisible();
  await page.waitForFunction(
    () => (document.body.innerText || '').trim().length > 0,
    undefined,
  );
  const visibleText = await page.locator('body').innerText().catch(() => '');
  console.log(`[xverse] visible body text (first 500 chars): ${visibleText.slice(0, 500)}`);
  expect(visibleText.length).toBeGreaterThan(0);
});
