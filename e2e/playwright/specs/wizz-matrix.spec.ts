import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import { isOneAddressWallet } from '../../../src/cat21-fee/funding-safety.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { approvalGate, clickApprovalAndRequireClose, waitForApprovalPopup } from '../approval-popup';
import { onboardWizz } from '../onboard-wizz';
import { installWizzOfflineRoutes } from '../wizz-offline-routes';

/**
 * Iteration 4 of the Wizz E2E pipeline: matrix spec across the
 * address types that have public BIP test vectors.
 *
 * Wizz's restore-from-mnemonic flow shows a Step-3 picker with
 * four visible rows (plus an "Other Address Types" collapsed
 * section). Only two of those use standard BIP derivations with
 * public test vectors for `abandon × 11 + about`:
 *   - "Native Segwit (P2WPKH)"  → BIP-84 m/84'/0'/0'/0/0
 *   - "Taproot (P2TR)"          → BIP-86 m/86'/0'/0'/0/0
 *
 * The two other visible rows ("Legacy & Taproot", "Legacy &
 * Native SegWit") use Wizz-specific hybrid derivations on m/44
 * paths with non-standard mixed script types and aren't worth
 * pinning here — they aren't reachable via cat21 mint anyway
 * (the mint signer only handles P2WPKH and P2SH-P2WPKH payment
 * inputs).
 *
 * Wizz strips data-testid attributes from its build, so address-
 * type selection uses text labels — same pattern as the onboard
 * spec.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/wizz');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

interface WizzAddressTypeVariant {
  /** Exact label on the Step-3 address-type row */
  rowLabel: string;
  /** human label for test name + logging */
  label: string;
  /** expected derivation of `abandon × 11 + about` on mainnet */
  expectedAddress: string;
}

const VARIANTS: ReadonlyArray<WizzAddressTypeVariant> = [
  {
    rowLabel: 'Native Segwit (P2WPKH)',
    label: 'P2WPKH (BIP-84 Native SegWit)',
    expectedAddress: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  },
  {
    rowLabel: 'Taproot (P2TR)',
    label: 'P2TR (BIP-86 Taproot)',
    expectedAddress: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
  },
];

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `wizz-matrix-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>, variantTag: string): Promise<void> {
  // URL-anchor the match on Wizz's notification#/approval surface so
  // we never mistake a transient welcome/scan-progress page for the
  // approval (confirmed by the wizz-sdk-handshake CI log line).
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    // Anchored on the CONTROL this helper clicks, with the URL as a cheap
    // pre-filter: a hash route matches while the popup is still a boot spinner.
    isApproval: approvalGate({
      url: /notification\.html#\/approval/,
      control: (p) => p.getByText(/^Connect$/).first(),
    }),
  });
  // eslint-disable-next-line no-console
  console.log(`[wizz-matrix:${variantTag}] approval URL = ${approval.url()}`);
  await approval.screenshot({ path: path.resolve(RESULTS_DIR, `wizz-matrix-${variantTag}-approval-rendered.png`), fullPage: true }).catch(() => undefined);
  // Wizz closes the popup the moment it accepts the approval, so the close is
  // the proof the click landed.
  await clickApprovalAndRequireClose(approval.getByText(/^Connect$/).first(), approval, { label: `Wizz connect popup ${variantTag}` });
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Wizz extension not unpacked at ${EXT_PATH}. This is a missing prerequisite, not a test failure: run e2e/playwright/playwright-bootstrap.sh wizz.`);
  }
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) {
    throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');
  }
});

for (const variant of VARIANTS) {
  test(`SDK returns the right address for Wizz ${variant.label}`, async () => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    // Both address types derive locally from the seed: P2TR needs nothing
    // from configs.wizz.cash, which the helper aborts along with the rest of
    // Wizz's own backends (the Taproot roundtrip specs connect the same way).
    await installWizzOfflineRoutes(context);

    try {
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker');
      const extensionId = worker.url().split('/')[2];

      const dashboardPage = await context.newPage();
      await onboardWizz(dashboardPage, extensionId, { addressTypeRowLabel: variant.rowLabel });

      // The onboarding tab has done its job. Wizz keys dApp sessions by tab id
      // and its own UI tabs connect on a separate port branch with no session,
      // so closing it does not affect the harness tab's check-in (waited for
      // below).
      await dashboardPage.close().catch(() => undefined);

      const harness = await context.newPage();
      await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
      await harness.waitForFunction(
        () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
        undefined,
      );

      const variantTag = variant.rowLabel.replace(/[^a-z0-9]+/gi, '-');
      // Wizz's background answers every dApp request except `tabCheckin`,
      // `keepAlive` and `getInjectWallets` with -32603 "Connection error,
      // please try again" until this tab's session carries an origin, and
      // only `tabCheckin` sets it (background.js 2.13.4, byte 2285230). The
      // page provider sends `tabCheckin` once, from a 100 ms poll on
      // `document.readyState === 'complete'`, so it can land after
      // `ordpoolSdkHarnessReady`. Before it lands `requestAccounts` is refused;
      // after it, `requestAccounts` opens the Connect approval. `getNetwork`
      // passes the same guard and opens no popup, so it succeeding is the
      // observable "checked in" state.
      //
      // expect.poll, not waitForFunction: waitForFunction does not await an
      // async predicate, it fulfils on the returned Promise (always truthy)
      // after one call, so it cannot wait on an async wallet answer.
      await expect.poll(() => harness.evaluate(async () => {
        const w = (window as unknown as { wizz?: { getNetwork?: () => Promise<unknown> } }).wizz;
        if (!w?.getNetwork) return 'no window.wizz.getNetwork';
        try {
          await w.getNetwork();
          return 'checked-in';
        } catch (e) {
          const err = e as { code?: unknown; message?: unknown };
          return `getNetwork refused: ${String(err?.code)} ${String(err?.message)}`;
        }
      }), { message: 'Wizz session for the harness tab never checked in' }).toBe('checked-in');

      // Diagnostic: surface whether the wizz provider is even on the
      // harness page. Previous iterations swallowed connectWizz
      // rejections with a silent .catch(), so a "not injected" or
      // synchronous reject looked identical to a popup-no-show.
      const wizzVisible = await harness.evaluate(() => {
        return typeof (window as unknown as { wizz?: unknown }).wizz !== 'undefined';
      });
      // eslint-disable-next-line no-console
      console.log(`[wizz-matrix:${variant.label}] window.wizz detected on harness = ${wizzVisible}`);

      const knownPages = new Set(context.pages());
      const resultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectWizz());
      // Race popup-wait against connectWizz. If connectWizz rejects
      // fast (wallet returned an error without showing a popup), we
      // see THAT error instead of the misleading "popup did not
      // appear within 60s" timeout.
      const info = await Promise.race([
        resultPromise,
        approveConnectPopup(context, knownPages, variantTag).then(() => resultPromise),
      ]);

      // eslint-disable-next-line no-console
      console.log(`[wizz-matrix:${variant.label}] address = ${info.paymentAddress}`);
      await shot(harness, `${variant.rowLabel.replace(/[^a-z0-9]+/gi, '-')}-after-connect`);

      expect(info.paymentAddress).toBe(variant.expectedAddress);
      // Wizz's single-address contract (inherited from Unisat):
      // ordinalsAddress mirrors paymentAddress.
      expect(info.ordinalsAddress).toBe(variant.expectedAddress);
      // The funding ruling's notice-vs-block decision is DERIVED from the
      // wallet's own addresses (`isOneAddressWallet`), and every unit test of
      // that decision ASSUMES the topology rather than establishing it. This
      // is the only place a real wallet binary supplies the fact, so it is
      // the one assertion that can catch a wallet changing its address model:
      // one that collapsed to a single address would keep being merely
      // noticed while its assets and its spending money share a lane.
      expect(isOneAddressWallet(info)).toBe(true);
    } finally {
      await context.close();
    }
  });
}
