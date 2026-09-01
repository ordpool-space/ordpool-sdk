import { chromium } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForChromeStorageKey, waitForSingletonLockGone } from './wait-helpers';
import { onboardXverse, primeAndSwitchToRegtest, overrideRegtestElectrsUrl } from './onboard-xverse';

/**
 * Playwright globalSetup — runs ONCE before any spec.
 *
 * SPEED OPTIMIZATION LAYER of the Xverse gold-standard pattern.
 * See `/Work/ordpool/WALLETS.md` → "HARD RULE: The Xverse pattern is
 * the gold standard" for the full mental model. The TL;DR: this file
 * runs the FULL onboarding click-through once (via onboard-xverse.ts)
 * and caches the result; downstream specs (matrix × 4, mint-roundtrip)
 * clone the seed dir for fresh contexts in <2s instead of repeating
 * 25s of UI clicks.
 *
 * The companion *source-of-truth* layer is `specs/xverse-onboard.spec.ts`,
 * which runs the same click-through against every CI push so wallet
 * version bumps that break selectors fail loudly. DO NOT delete the
 * onboard spec thinking this globalSetup covers it — the seed cache
 * regenerates silently and would mask broken onboarding.
 *
 * The onboarding + regtest-switch itself lives in onboard-xverse.ts
 * (shared with the specs + the local wallet-runner). This file owns only
 * the seed-cache + chrome.storage.local dump.
 */

const EXT_PATH = path.resolve(__dirname, '../extensions/xverse');
// Seeded chromium user-data-dir — specs clone this per-test so each
// gets a fresh context but skip the onboarding click flow.
export const SEED_USER_DATA_DIR = process.env.XVERSE_SEED_USER_DATA_DIR
  ?? path.resolve(__dirname, '../../test-results/xverse-seed-user-data-dir');

export default async function globalSetup(): Promise<void> {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Xverse extension not unpacked at ${EXT_PATH}. Run e2e/playwright/playwright-bootstrap.sh.`);
  }

  // The wallet-matrix runs one shard per wallet (the CI sets WALLET);
  // only the xverse-*.spec.ts clone this seed, so every non-xverse shard
  // skips the ~25s Xverse onboarding entirely.
  if (process.env.WALLET && process.env.WALLET !== 'xverse') {
    // eslint-disable-next-line no-console
    console.log(`[globalSetup] ${process.env.WALLET} shard — skipping Xverse seed (only xverse specs use it)`);
    return;
  }

  // Reuse the seeded dir only when it exists AND was produced by the
  // SAME extension version. Keying on mere existence let a local .crx
  // bump silently reuse a stale profile, masking the selector drift the
  // onboard spec exists to catch.
  const extVersion = (JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'manifest.json'), 'utf8')) as { version: string }).version;
  const versionMarker = path.join(SEED_USER_DATA_DIR, '.xverse-ext-version');
  if (
    fs.existsSync(path.join(SEED_USER_DATA_DIR, 'Default')) &&
    fs.existsSync(versionMarker) &&
    fs.readFileSync(versionMarker, 'utf8') === extVersion &&
    !process.env.XVERSE_FORCE_REONBOARD
  ) {
    // eslint-disable-next-line no-console
    console.log(`[globalSetup] reusing seed user-data-dir (Xverse ${extVersion}) at ${SEED_USER_DATA_DIR}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[globalSetup] onboarding Xverse + switching to Regtest…`);
  fs.rmSync(SEED_USER_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(SEED_USER_DATA_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(SEED_USER_DATA_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const extensionId = worker.url().split('/')[2];

  try {
    await onboardXverse(context, extensionId);
    await primeAndSwitchToRegtest(context, extensionId);
    // Point Xverse's Regtest network at the local electrs the
    // mint-roundtrip spec hits. Without this override Xverse would
    // try to broadcast against sBTC mempool. The override is
    // ignored by the address-handshake spec (it only does
    // getAddress, no API calls) but matters for signTransaction.
    const electrsUrl = process.env.XVERSE_REGTEST_ELECTRS_URL ?? 'http://localhost:3000';
    await overrideRegtestElectrsUrl(context, extensionId, electrsUrl);
    // eslint-disable-next-line no-console
    console.log(`[globalSetup] overrode bitcoin-regtest.electrsApiUrl = ${electrsUrl}`);
    // Gate the close on the onboarded state having actually materialised
    // in chrome.storage.local — confirms LevelDB flushed the final
    // writes from primeAndSwitchToRegtest. Without this gate, the
    // cloned user-data-dir misses the last few writes and the wallet
    // appears un-onboarded to specs launched from the clone.
    await waitForChromeStorageKey({ context, keyContains: 'walletState', timeoutMs: 30_000 });
  } finally {
    await context.close();
  }
  // After close, wait for Chrome to release its singleton lock so
  // downstream tests can safely clone the user-data-dir.
  await waitForSingletonLockGone(SEED_USER_DATA_DIR).catch(() => undefined);
}
