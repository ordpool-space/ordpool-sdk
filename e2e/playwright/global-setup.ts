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
// NOT under `outputDir` (test-results): Playwright clears that directory at
// the start of every run, so a cache kept there is deleted before globalSetup
// can read it and the ~25 s onboarding is re-paid every time. Neutral in CI,
// where each job runs one wallet and onboards once regardless; it also keeps a
// wallet profile from riding along inside the failure artifact.
/**
 * Where the seeded, already-onboarded browser profile lives.
 *
 * The env name is wallet-agnostic on purpose. What it points at is "the
 * profile for the wallet this harness seeds", and baking one wallet's name
 * into a consumer-facing variable means the next wallet either collides with
 * it or needs a second variable saying the same thing. Xverse is simply the
 * wallet seeded today; a second one would take a subdirectory keyed by wallet
 * name rather than another env var.
 *
 * `XVERSE_SEED_USER_DATA_DIR` is still honoured so a consumer that already
 * sets it keeps working.
 */
export const SEED_USER_DATA_DIR =
  process.env.E2E_WALLET_SEED_DIR
  ?? process.env.XVERSE_SEED_USER_DATA_DIR
  ?? path.resolve(__dirname, '.wallet-seed/user-data-dir');

/** Re-onboard even when a reusable profile is present. Same naming reasoning. */
const forceReonboard = (): boolean =>
  Boolean(process.env.E2E_WALLET_FORCE_REONBOARD ?? process.env.XVERSE_FORCE_REONBOARD);

/**
 * Assert the seed really landed, before this step reports success.
 *
 * A setup step whose success is its EXIT CODE rather than its OUTPUT is a
 * green that lies: the consumer's next step fails instead, far from the cause,
 * and the failure reads like the consumer's bug. This turns that into a loud
 * failure at the producer.
 */
function assertSeedLanded(where: string): void {
  const defaultProfile = path.join(SEED_USER_DATA_DIR, 'Default');
  if (!fs.existsSync(defaultProfile)) {
    throw new Error(
      `[globalSetup] ${where} but produced no seed profile at ${defaultProfile}. ` +
      'Reporting success here would fail in whatever runs next, far from the cause.',
    );
  }
}

export default async function globalSetup(): Promise<void> {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Xverse extension not unpacked at ${EXT_PATH}. This is a missing prerequisite, not a test failure: run e2e/playwright/playwright-bootstrap.sh xverse.`);
  }

  // The wallet-matrix runs one shard per wallet (the CI sets WALLET);
  // only the xverse-*.spec.ts clone this seed, so every non-xverse shard
  // skips the ~25s Xverse onboarding entirely.
  if (process.env.WALLET && process.env.WALLET !== 'xverse') {
    // Correct for the wallet matrix, where one shard runs one wallet. It is a
    // trap for a consumer invoking this AS a producer step: nothing is
    // produced and the exit code is 0, so the failure surfaces later as a
    // missing directory. Say so in the log, loudly enough to find.
    // eslint-disable-next-line no-console
    console.log(
      `[globalSetup] WALLET=${process.env.WALLET} (not xverse) — NO Xverse seed will be produced. ` +
      'If you invoked this to produce one, unset WALLET or set it to xverse.',
    );
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
    !forceReonboard()
  ) {
    // eslint-disable-next-line no-console
    console.log(`[globalSetup] reusing seed user-data-dir (Xverse ${extVersion}) at ${SEED_USER_DATA_DIR}`);
    // No assertSeedLanded here: the condition above already required
    // `Default` to exist, so an assertion at this point cannot fail. It is the
    // produce path below that can report success without leaving output.
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
    const electrsUrl =
      process.env.XVERSE_REGTEST_ELECTRS_URL ??
      `http://localhost:${process.env.E2E_ELECTRS_HOST_PORT ?? 3010}`;
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

  assertSeedLanded('onboarded Xverse');
}
