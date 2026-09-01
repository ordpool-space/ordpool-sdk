import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup } from '../approval-popup';
import { onboardWizz } from '../onboard-wizz';

/**
 * Iteration 3 of the Wizz E2E pipeline: SDK ↔ Wizz handshake.
 *
 * Wizz is a Unisat fork; the same single-address-for-both-lanes
 * model applies (one BIP-84 derivation answers `paymentAddress`
 * and `ordinalsAddress`). What's different from Unisat:
 *   - Wizz strips data-testid attributes, so onboarding uses
 *     text selectors (see wizz-onboard.spec.ts).
 *   - After picking the address type, Wizz shows a "Security Tips"
 *     modal with three acknowledgement checkboxes that gate OK
 *     before the dashboard renders.
 *   - The connection-request approval popup likely renders
 *     "Connect" as a styled <div> (same as Unisat); we match on
 *     text rather than role.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/wizz');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

// BIP-84 native segwit derivation of TEST_MNEMONIC on mainnet:
//   m/84'/0'/0'/0/0
// Same address Unisat returns for the same seed (Wizz inherits
// Unisat's default derivation path).
const EXPECTED_PAYMENT_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

let context: BrowserContext;
let extensionId: string;

async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({
      path: path.resolve(RESULTS_DIR, `wizz-handshake-${name}.png`),
      fullPage: true,
    });
  } catch {
    // diagnostic, never fatal
  }
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Wizz extension not unpacked at ${EXT_PATH}.`);
  }
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) {
    throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');
  }

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  // Wizz's dashboard fires GET https://configs.wizz.cash/extension/<v>
  // on mount; CI has no outbound internet so the fetch hangs and blocks
  // Wizz's requestAccounts handler. Abort the request at the browser
  // layer so Wizz falls back to its default config immediately.
  await context.route('**/configs.wizz.cash/**', route => route.abort());

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = worker.url().split('/')[2];

  const onboardPage = await context.newPage();
  // The onboard helper runs the same flow as wizz-onboard.spec.ts;
  // override the test timeout because of the multi-step traversal.
  test.setTimeout(180_000);
  await onboardWizz(onboardPage, extensionId);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('wizzConnector.connect via the harness page returns the BIP-84 mainnet address for the test seed', async () => {
  test.setTimeout(180_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });

  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  // wizz.requestAccounts() triggers an approval popup on a new
  // chrome-extension:// page. Listen for the new page event, then
  // click whatever Connect/Approve button it renders.
  const knownPages = new Set(context.pages());
  const resultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectWizz());

  // URL-anchor the match on Wizz's notification#/approval surface.
  let approval: Page;
  try {
    approval = await waitForApprovalPopup({
      context,
      knownPages,
      isApproval: async (p) => {
        await p.waitForURL(/notification\.html#\/approval/, { timeout: 60_000 });
        return true;
      },
    });
  } catch {
    await shot(harness, '02a-no-approval');
    throw new Error('wizz connection-request popup never appeared');
  }
  await shot(approval, '02a-approval-rendered');
  // eslint-disable-next-line no-console
  console.log(`[wizz:sdk-handshake] approval URL = ${approval.url()}`);

  // Wizz inherits Unisat's connect-approval shape — "Connect" is
  // a styled <div> rather than a <button>. Match by exact text.
  const consentBtn = approval.getByText(/^Connect$/).first();
  await expect(consentBtn).toBeVisible({ timeout: 10_000 });
  await consentBtn.click();
  await shot(approval, '02b-after-approve');

  const info = await resultPromise;
  // eslint-disable-next-line no-console
  console.log(`[wizz:sdk-handshake] paymentAddress = ${info.paymentAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[wizz:sdk-handshake] paymentPublicKey = ${info.paymentPublicKey}`);
  await shot(harness, '03-after-connect');

  expect(info.signingSupported).toBe(true);
  expect(info.paymentAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  // Wizz, like Unisat, reuses one address for both lanes.
  expect(info.ordinalsAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  // Compressed pubkey = 33 bytes = 66 hex chars.
  expect(info.paymentPublicKey).toMatch(/^[0-9a-f]{66}$/);
});
