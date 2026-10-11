import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { installPhantomOfflineRoutes } from '../phantom-offline-routes';

/**
 * Iteration 1 of the Phantom E2E pipeline: prove that we can load
 * the published .crx into a headed Chromium in CI and read back
 * basic facts about the extension (its ID, manifest version,
 * entry-point screenshot, DOM snippet).
 *
 * Same scaffolding as the other *-loads specs. The mnemonic-
 * restore flow + signer wiring land in subsequent iterations,
 * informed by the screenshot + DOM snapshot this run produces.
 *
 * Entry point per manifest: `popup.html`.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/phantom');

let context: BrowserContext;
let extensionId: string;
let manifestVersion: string;

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(
      `Phantom extension not unpacked at ${EXT_PATH}. ` +
      `Run e2e/playwright/playwright-bootstrap.sh phantom first.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'manifest.json'), 'utf8'));
  manifestVersion = manifest.version;
  console.log(`[phantom] loading extension v${manifestVersion} from ${EXT_PATH}`);

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  // Phantom's vendor backends are aborted.
  await installPhantomOfflineRoutes(context);

  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker');
  }
  extensionId = worker.url().split('/')[2];
  console.log(`[phantom] service worker URL = ${worker.url()}`);
  console.log(`[phantom] extension id = ${extensionId}`);
});

test.afterAll(async () => {
  await context?.close();
});

test('Phantom loads in Chromium with a service worker registered; its popup hands an unonboarded wallet over to onboarding.html', async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);

  const startupPages = context.pages();
  console.log(`[phantom] startup pages: ${startupPages.map(p => p.url()).join(', ')}`);
  for (const [i, p] of startupPages.entries()) {
    await p.screenshot({
      path: path.resolve(__dirname, `../../../test-results/phantom-startup-page-${i}.png`),
      fullPage: true,
    });
  }

  // Phantom 26.16.0's popup reads the extension's lock state first. For a
  // wallet with no vault (this one: nothing is onboarded here) the state is
  // "onboarding", and the popup's auth gate calls its `openOnboarding`:
  // `tabs.create({ url: 'onboarding.html' })`, then `self.close()` (Popup.js
  // and chunk-UFGVTFBO.js). So the popup tab closing and a NEW onboarding.html
  // tab rendering is the behaviour under test. The close is awaited before
  // anything else touches the popup, because every later call on it would fail
  // on a closed target. Pages open before the popup are excluded, so an
  // onboarding tab Phantom opened at install cannot stand in for this one.
  const pagesBeforePopup = new Set(context.pages());
  const popup = await context.newPage();
  const popupClosed = popup.waitForEvent('close');
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'commit' });
  await popupClosed;

  const onboardingUrl = new RegExp(`^chrome-extension://${extensionId}/onboarding\\.html`);
  const openedByPopup = (): Page | undefined =>
    context.pages().find((p) => !pagesBeforePopup.has(p) && onboardingUrl.test(p.url()));
  await expect
    .poll(() => openedByPopup() !== undefined, {
      message: 'Phantom opened no onboarding.html after its popup closed',
    })
    .toBe(true);
  const onboarding = openedByPopup() as Page;
  // Rendered means the React app mounted: the body carries text.
  await expect(onboarding.locator('body')).not.toHaveText(/^\s*$/);
  console.log(`[phantom] onboarding URL   = ${onboarding.url()}`);
  console.log(`[phantom] onboarding title = ${await onboarding.title()}`);
  await onboarding.screenshot({
    path: path.resolve(__dirname, `../../../test-results/phantom-index.png`),
    fullPage: true,
  });
  const bodyHtml = await onboarding.evaluate(() => document.body.innerHTML.slice(0, 4000));
  fs.writeFileSync(
    path.resolve(__dirname, `../../../test-results/phantom-body-snippet.html`),
    bodyHtml,
  );
  const visibleText = await onboarding.locator('body').innerText();
  console.log(`[phantom] visible body text (first 500 chars): ${visibleText.slice(0, 500)}`);
});
