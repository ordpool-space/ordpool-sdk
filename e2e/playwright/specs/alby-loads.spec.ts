import { test, expect, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { installAlbyOfflineRoutes } from '../alby-offline-routes';
import { launchWalletContext } from '../launch-wallet-context';

/**
 * Iteration 1 of the Alby E2E pipeline: prove that we can load
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

const EXT_PATH = path.resolve(__dirname, '../../extensions/alby');

let context: BrowserContext;
let extensionId: string;
let manifestVersion: string;

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(
      `Alby extension not unpacked at ${EXT_PATH}. ` +
      `Run e2e/playwright/playwright-bootstrap.sh alby first.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'manifest.json'), 'utf8'));
  manifestVersion = manifest.version;
  console.log(`[alby] loading extension v${manifestVersion} from ${EXT_PATH}`);

  context = await launchWalletContext({
    wallet: 'alby',
    extensionPath: EXT_PATH,
  });
  // The seeded account's placeholder LNDHub is aborted, never looked up.
  await installAlbyOfflineRoutes(context);

  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker');
  }
  extensionId = worker.url().split('/')[2];
  console.log(`[alby] service worker URL = ${worker.url()}`);
  console.log(`[alby] extension id = ${extensionId}`);
});

test.afterAll(async () => {
  await context?.close();
});

test('Alby loads in Chromium with a service worker registered; its popup hands an unconfigured wallet over to welcome.html', async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);

  const startupPages = context.pages();
  console.log(`[alby] startup pages: ${startupPages.map(p => p.url()).join(', ')}`);
  for (const [i, p] of startupPages.entries()) {
    await p.screenshot({
      path: path.resolve(__dirname, `../../../test-results/alby-startup-page-${i}.png`),
      fullPage: true,
    });
  }

  // Alby's popup.html asks the background for its status first. A wallet
  // with no account (this one: nothing is onboarded here) gets
  // `openPage('welcome.html')` and `window.close()` from the popup, so the
  // popup tab closing and welcome.html rendering is the behaviour under test.
  // The close is awaited before anything else touches the popup, because
  // every later call on it would fail on a closed target.
  const popup = await context.newPage();
  const popupClosed = popup.waitForEvent('close');
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'commit' });
  await popupClosed;

  const welcomeUrl = new RegExp(`^chrome-extension://${extensionId}/welcome\\.html`);
  await expect
    .poll(() => context.pages().some((p) => welcomeUrl.test(p.url())), {
      message: 'Alby opened no welcome.html after its popup closed',
    })
    .toBe(true);
  const welcome = context.pages().find((p) => welcomeUrl.test(p.url())) as Page;
  // Rendered means the React app mounted: the body carries text.
  await expect(welcome.locator('body')).not.toHaveText(/^\s*$/);
  console.log(`[alby] welcome URL   = ${welcome.url()}`);
  console.log(`[alby] welcome title = ${await welcome.title()}`);
  await welcome.screenshot({
    path: path.resolve(__dirname, `../../../test-results/alby-index.png`),
    fullPage: true,
  });
  const bodyHtml = await welcome.evaluate(() => document.body.innerHTML.slice(0, 4000));
  fs.writeFileSync(
    path.resolve(__dirname, `../../../test-results/alby-body-snippet.html`),
    bodyHtml,
  );
  const visibleText = await welcome.locator('body').innerText();
  console.log(`[alby] visible body text (first 500 chars): ${visibleText.slice(0, 500)}`);
});
