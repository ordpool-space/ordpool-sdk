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
      `Run e2e/playwright/playwright-bootstrap.sh first.`,
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
    worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  }
  // chrome-extension://<id>/<path>
  extensionId = worker.url().split('/')[2];
  console.log(`[xverse] service worker URL = ${worker.url()}`);
  console.log(`[xverse] extension id = ${extensionId}`);
});

test.afterAll(async () => {
  await context?.close();
});

test('Xverse loads in Chromium, exposes a service worker, and renders its onboarding entry point', async () => {
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

  // Navigate to the extension's index.html (Xverse's main entry).
  // If it's an SPA the URL may rewrite on first load.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`, {
    waitUntil: 'domcontentloaded',
  });

  // Give the extension a moment to settle (React mount, route
  // resolution, etc.). We don't know what it renders yet.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
    console.log('[xverse] networkidle timed out, continuing with whatever rendered');
  });

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

  // Body should at least exist and contain SOMETHING. We'll
  // tighten this to "contains 'Restore' or 'Create' text" once
  // we've seen the first CI screenshot.
  await expect(page.locator('body')).toBeVisible();
  const visibleText = await page.locator('body').innerText().catch(() => '');
  console.log(`[xverse] visible body text (first 500 chars): ${visibleText.slice(0, 500)}`);
  expect(visibleText.length).toBeGreaterThan(0);
});
