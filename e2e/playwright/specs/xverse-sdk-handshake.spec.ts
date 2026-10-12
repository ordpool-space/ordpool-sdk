import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SEED_USER_DATA_DIR } from '../global-setup';
import { installXverseOfflineRoutes } from '../xverse-offline-routes';
import { approveXverseConnect, unlockXverse } from '../xverse-popup';
import { launchWalletContext } from '../launch-wallet-context';
import { HARNESS_URL } from '../../regtest/regtest-helpers';

/**
 * Iteration 3a — SDK ↔ Xverse handshake via sats-connect.
 *
 * After Iteration 2's onboarding spec commits a wallet to extension
 * storage, this spec loads the SDK harness page (HTML + bundled
 * connector/signer code served from HARNESS_URL), drives
 * our `xverseConnector.connect(Network.Testnet4)`, and asserts the
 * returned `paymentAddress` / `ordinalsAddress` match the well-known
 * BIP-84 / BIP-86 testnet derivations of the BIP-39 test seed
 * `abandon × 11 + about`.
 *
 * This proves:
 *   - the published Xverse extension responds to sats-connect calls
 *     made from a page loaded in our automated browser context
 *   - our SDK's xverseConnector code path parses the response into
 *     the expected WalletInfo shape
 *   - the address derivation Xverse uses matches the canonical
 *     BIP-84/86 path (so iteration 3c can re-encode to bcrt1 for
 *     the regtest mint roundtrip)
 *
 * Onboarding runs inline at the start of this spec (we don't
 * depend on test ordering with xverse-onboard.spec.ts; each spec
 * is responsible for its own wallet state).
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/xverse');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'TestPassword123!';

// Expected derivations for the test seed are different per network.
// Xverse exposes a built-in Regtest network (chain=bitcoin, mode=
// regtest) which we activate via the popup settings UI before
// calling connect. coin_type=1 for regtest (same as testnet);
// addresses use the bcrt1 bech32 HRP. We don't pin the exact
// strings yet — the first run logs them; iteration 3b commits
// the verified values.

let context: BrowserContext;
let extensionId: string;

async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({
      path: path.resolve(RESULTS_DIR, `handshake-${name}.png`),
      fullPage: true,
    });
  } catch {
    // diagnostic only
  }
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Xverse extension not unpacked at ${EXT_PATH}. This is a missing prerequisite, not a test failure: run e2e/playwright/playwright-bootstrap.sh xverse.`);
  }
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) {
    throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');
  }
  if (!fs.existsSync(path.join(SEED_USER_DATA_DIR, 'Default'))) {
    throw new Error(`Xverse seed user-data-dir missing at ${SEED_USER_DATA_DIR}. globalSetup should have produced it.`);
  }

  // Clone the seeded user-data-dir to a fresh per-spec working
  // directory. Two contexts cannot share the same dir (chromium's
  // Singleton lock); copying gives every spec its own onboarded
  // wallet without re-running the click flow.
  const workingDir = `${SEED_USER_DATA_DIR}.spec-${process.pid}-${Date.now()}`;
  fs.cpSync(SEED_USER_DATA_DIR, workingDir, { recursive: true });
  // Strip the SingletonLock files left over from the previous
  // launch; chromium would otherwise refuse to start.
  for (const stale of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(workingDir, stale), { force: true });
  }

  context = await launchWalletContext({
    wallet: 'xverse',
    extensionPath: EXT_PATH,
    userDataDir: workingDir,
  });
  await installXverseOfflineRoutes(context);

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2];

  // Confirm the cloned context boots with the seeded vault keys
  // visible to the extension. If this assertion ever fails the
  // clone has a flush race — global-setup's chrome.storage.local
  // writes didn't make it through chromium's leveldb on disk.
  const diag = await context.newPage();
  await diag.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  const seededKeys = await diag.evaluate(() => new Promise<string[]>((resolve) => {
    const c = (window as unknown as { chrome: { storage: { local: { get: (k: null, cb: (v: Record<string, unknown>) => void) => void } } } }).chrome;
    c.storage.local.get(null, (v) => resolve(Object.keys(v)));
  }));
  // eslint-disable-next-line no-console
  console.log(`[sdk-handshake.beforeAll] cloned storage has ${seededKeys.length} keys`);
  expect(seededKeys).toEqual(expect.arrayContaining([
    'vault::version',
    'vault::passwordSalt',
    'vault::encryptionVault',
    'vault::seedVault',
    'persistentStore::networks',
  ]));
  await diag.close();
});

test.afterAll(async () => {
  await context?.close();
});

test('xverseConnector.connect via the harness page returns the expected BIP-84/BIP-86 regtest addresses for the test seed', async () => {
  // Unlock the wallet: it boots from the cloned user-data-dir into the lock
  // screen (the vault is encrypted at rest, the key is not kept across a
  // context restart).
  const primer = await unlockXverse(context, extensionId);
  await shot(primer, '00c-primer-dashboard');

  // Open the harness page after priming. Close any leftover tabs
  // EXCEPT the primer (Xverse's state machine seems to rely on
  // popup.html being open) and the harness itself.
  const page = await context.newPage();
  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  for (const p of context.pages()) {
    if (p !== page && p !== primer) await p.close().catch(() => undefined);
  }

  // Wait for the SDK harness bundle to run + set its ready flag.
  await page.waitForFunction(() => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true, undefined);
  await shot(page, '01-harness-loaded');

  // sats-connect's getAddress makes Xverse open its approval UI in a
  // separate extension window (chrome-extension:// origin), not the
  // harness page; approveXverseConnect finds it by its consent button.
  // Wallet was switched into Bitcoin Regtest above via the primer's
  // Settings → Networks panel. Ask the SDK to connect on Regtest;
  // our toBitcoinNetworkType maps Network.Regtest to the literal
  // string "Regtest" which Xverse's mismatch-check accepts.
  const info = await approveXverseConnect(context, () => page.evaluate(() => window.ordpoolSdkHarness.connectXverse('regtest')));
  // eslint-disable-next-line no-console
  console.log(`[xverse:sdk-handshake] payment  = ${info.paymentAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[xverse:sdk-handshake] ordinals = ${info.ordinalsAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[xverse:sdk-handshake] payment.pubkey  = ${info.paymentPublicKey}`);
  // eslint-disable-next-line no-console
  console.log(`[xverse:sdk-handshake] ordinals.pubkey = ${info.ordinalsPublicKey}`);
  await shot(page, '03-after-connect');

  expect(info.signingSupported).toBe(true);
  // BIP-84 native SegWit regtest → bcrt1q...; BIP-86 Taproot regtest → bcrt1p...
  expect(info.paymentAddress).toMatch(/^bcrt1q[ac-hj-np-z02-9]{38,}$/);
  expect(info.ordinalsAddress).toMatch(/^bcrt1p[ac-hj-np-z02-9]{56,}$/);
  // Pubkeys: payment compressed = 33 bytes = 66 hex; ordinals
  // x-only = 32 bytes = 64 hex.
  expect(info.paymentPublicKey).toMatch(/^[0-9a-f]{66}$/);
  expect(info.ordinalsPublicKey).toMatch(/^[0-9a-f]{64}$/);
});
