import { test, expect, chromium, BrowserContext } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 1 of the Unisat E2E pipeline: prove that we can load
 * the published .crx into a headed Chromium in CI and read back
 * basic facts about the extension (its ID, manifest version,
 * entry-point screenshot, DOM snippet).
 *
 * No onboarding flow yet — Unisat's UI selectors are unknown
 * without first seeing the CI screenshot of whatever page renders
 * after install. The mnemonic-restore flow lands in iteration 2,
 * informed by the screenshot + DOM snapshot this run produces.
 *
 * Unisat is open-source (github.com/unisat-wallet/extension, MIT)
 * so subsequent iterations can cross-reference the source instead
 * of bundle-archaeology like Xverse needed.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');

let context: BrowserContext;
let extensionId: string;
let manifestVersion: string;

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(
      `Unisat extension not unpacked at ${EXT_PATH}. ` +
      `Run e2e/playwright/playwright-bootstrap.sh unisat first.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'manifest.json'), 'utf8'));
  manifestVersion = manifest.version;
  console.log(`[unisat] loading extension v${manifestVersion} from ${EXT_PATH}`);

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
  console.log(`[unisat] service worker URL = ${worker.url()}`);
  console.log(`[unisat] extension id = ${extensionId}`);
});

test.afterAll(async () => {
  await context?.close();
});

test('Unisat loads in Chromium, exposes a service worker, and renders its index entry point', async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/); // chromium extension IDs are 32 lowercase a-p chars

  // Many extensions auto-open a tab on first install. Capture
  // whatever's there for diagnosis.
  const startupPages = context.pages();
  console.log(`[unisat] startup pages: ${startupPages.map(p => p.url()).join(', ')}`);

  for (const [i, p] of startupPages.entries()) {
    try {
      await p.screenshot({
        path: path.resolve(__dirname, `../../../test-results/unisat-startup-page-${i}.png`),
        fullPage: true,
      });
    } catch (e) {
      console.log(`[unisat] couldn't screenshot startup page ${i}: ${(e as Error).message}`);
    }
  }

  // Unisat's manifest exposes index.html (popup + side-panel both
  // route through it).
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`, {
    waitUntil: 'domcontentloaded',
  });

  // Give the extension a moment to settle (React mount, route
  // resolution, etc.). We don't know what it renders yet.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
    console.log('[unisat] networkidle timed out, continuing with whatever rendered');
  });

  const finalUrl = page.url();
  const title = await page.title();
  console.log(`[unisat] navigated URL = ${finalUrl}`);
  console.log(`[unisat] page title    = ${title}`);

  await page.screenshot({
    path: path.resolve(__dirname, '../../../test-results/unisat-index.png'),
    fullPage: true,
  });

  // Dump a chunk of the rendered DOM so the next iteration knows
  // what selectors are available.
  const bodyHtml = await page.evaluate(() => document.body.innerHTML.slice(0, 4000));
  fs.writeFileSync(
    path.resolve(__dirname, '../../../test-results/unisat-body-snippet.html'),
    bodyHtml,
  );

  // Body should at least exist and contain SOMETHING. Poll for
  // non-empty text — Unisat's React mount can race against an
  // immediate innerText read (`networkidle` doesn't gate React
  // hydration). Iteration 1 caught this once on CI 26379589137
  // where the body was empty at read time.
  await expect(page.locator('body')).toBeVisible();
  await page.waitForFunction(
    () => (document.body.innerText || '').trim().length > 0,
    undefined,
    { timeout: 10_000 },
  );
  const visibleText = await page.locator('body').innerText().catch(() => '');
  console.log(`[unisat] visible body text (first 500 chars): ${visibleText.slice(0, 500)}`);
  expect(visibleText.length).toBeGreaterThan(0);
});
