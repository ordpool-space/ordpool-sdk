import { expect, Page } from '@playwright/test';
import { isVisibleWithin } from './is-visible-within';
import { selectCard } from './select-card';

import { PASSWORD_BY_WALLET, TEST_MNEMONIC_WORDS } from './wallet-test-vectors';

/**
 * Probe: how long UniSat's update modal gets to appear. It shows only when
 * upstream has shipped past the pinned build, so absence is the common answer;
 * long enough for the server check behind it to answer on the first open.
 */
const UNISAT_UPDATE_NAG_PROBE_MS = 2_000;

/**
 * Probe: how long one best-effort dismissal step (a click, the modal or notice
 * going away) gets. These dismissals tolerate a miss; the `tab-home` assertion
 * is what proves onboarding finished.
 */
const UNISAT_DISMISS_STEP_PROBE_MS = 5_000;

/**
 * Probe: how long an onboarding step that only some address types or
 * releases show (the address-type card, the compatibility notice) gets to
 * render.
 */
const UNISAT_OPTIONAL_STEP_PROBE_MS = 5_000;

/**
 * Probe: how long the address-type Continue button gets to render. Absent
 * when UniSat skips the picker; it renders after the mnemonic import settles,
 * which takes longer than the other optional steps.
 */
const UNISAT_ADDRESS_TYPE_CONTINUE_PROBE_MS = 10_000;

/**
 * Dismiss UniSat's "a new version is available" modal.
 *
 * The pinned extension asks UniSat's server whether a newer build exists, so
 * the modal appears on the first dashboard open as soon as upstream ships a
 * release past the pin, and it is layered ABOVE the compatibility notice.
 * Playwright then reports the notice checkbox as visible, enabled and stable
 * while `.row-container` from `.popover-container` intercepts every click, so
 * the failure names the checkbox and not the thing covering it.
 *
 * The modal carries no data-testid, so it is anchored on the one string only
 * it contains; "Skip" alone would also match the notice below it.
 */
export async function dismissUnisatUpdateNag(page: Page): Promise<void> {
  const modal = page.locator('.popover-container').filter({ hasText: 'Go to update' });
  if (!(await isVisibleWithin(modal, UNISAT_UPDATE_NAG_PROBE_MS))) return;
  await modal.getByText('Skip', { exact: true }).click({ timeout: UNISAT_DISMISS_STEP_PROBE_MS }).catch(() => undefined);
  await modal.waitFor({ state: 'hidden', timeout: UNISAT_DISMISS_STEP_PROBE_MS }).catch(() => undefined);
}

/**
 * Dismiss the compatibility notice UniSat shows for SOME address types (nested
 * segwit and taproot) and not for others. Returns whether it was there.
 *
 * Best effort on purpose: the notice does not stand between the wallet and its
 * home screen, and its checkbox is an Ant-Design control whose input refuses a
 * direct click (`pointer-events` suppressed on the hidden box, the same quirk
 * the wizz helper documents for its fork of this UI). The caller's `tab-home`
 * assertion is what proves onboarding finished, so a notice that genuinely
 * blocked still fails there, naming the screen rather than a checkbox.
 */
export async function dismissUnisatNotice(page: Page): Promise<boolean> {
  const noticeCheckbox = page.getByTestId('notice-checkbox-1');
  if (!(await isVisibleWithin(noticeCheckbox, UNISAT_OPTIONAL_STEP_PROBE_MS))) return false;
  await noticeCheckbox.click({ timeout: UNISAT_DISMISS_STEP_PROBE_MS }).catch(() => undefined);
  const noticeOk = page.getByTestId('notice-ok-button');
  if (await noticeOk.isEnabled().catch(() => false)) {
    await noticeOk.click({ timeout: UNISAT_DISMISS_STEP_PROBE_MS }).catch(() => undefined);
  }
  return true;
}

/**
 * Drive UniSat onboarding from the BIP-39 test seed to the home tab.
 * Shared by the e2e specs AND the local wallet-runner (matches
 * onboard-okx.ts / onboard-phantom.ts / onboard-cat21wallet.ts).
 *
 * `addressTypeIndex` folds in the matrix variant: when set, the matching
 * address-type card is picked before continuing. UniSat is mainnet-only, so
 * roundtrip specs derive the regtest bcrt1 equivalents from the same pubkey.
 */
export async function onboardUnisat(
  page: Page,
  extensionId: string,
  opts: { addressTypeIndex?: number; password?: string; mnemonicWords?: string[] } = {},
): Promise<void> {
  const password = opts.password ?? PASSWORD_BY_WALLET.unisat;
  const words = opts.mnemonicWords ?? TEST_MNEMONIC_WORDS;

  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('welcome-title')).toBeVisible();
  await page.getByTestId('import-wallet-button').click();

  await expect(page.getByTestId('create-password-input')).toBeVisible();
  await page.getByTestId('create-password-input').fill(password);
  await page.getByTestId('create-password-confirm-input').fill(password);
  await page.getByTestId('create-password-continue-button').click();

  await expect(page.getByTestId('restore-wallet-type-option-0')).toBeVisible();
  await page.getByTestId('restore-wallet-type-option-0').click();

  await expect(page.getByTestId('mnemonic-import-word-0')).toBeVisible();
  for (let i = 0; i < words.length; i++) {
    await page.getByTestId(`mnemonic-import-word-${i}`).fill(words[i]);
  }
  await page.getByTestId('mnemonic-import-continue-button').click();

  if (opts.addressTypeIndex !== undefined) {
    const card = page.getByTestId(`address-type-card-${opts.addressTypeIndex}`);
    if (await isVisibleWithin(card, UNISAT_OPTIONAL_STEP_PROBE_MS)) {
      // A swallowed click here does not fail: onboarding continues with the
      // DEFAULT card selected and the wallet ends up on the wrong address
      // type, which surfaces much later as a spec asserting a bc1p address
      // against a bc1q one. Selecting is idempotent, so re-clicking is safe.
      const { clicks, observable, selected } = await selectCard(card);
      if (clicks > 1 || !observable || selected !== true) {
        console.log(
          `[onboard-unisat] address-type card ${opts.addressTypeIndex}: ` +
            `${clicks} click(s), marker ${observable ? 'readable' : 'NOT readable'}, ` +
            `selected=${String(selected)}`,
        );
      }
    }
  }
  const addressTypeContinue = page.getByTestId('address-type-continue-button');
  if (await isVisibleWithin(addressTypeContinue, UNISAT_ADDRESS_TYPE_CONTINUE_PROBE_MS)) {
    await addressTypeContinue.click();
  }

  // The update modal is layered above the compatibility notice and swallows
  // every click meant for it, so it goes first.
  await dismissUnisatUpdateNag(page);
  await dismissUnisatNotice(page);

  await expect(page.getByTestId('tab-home')).toBeVisible();
  await waitForUnisatInstallTabBooted(page, extensionId);
}

/**
 * Wait until the tab UniSat opens on install has booted.
 *
 * On a fresh install the background opens `index.html` in a new tab once its
 * own initialisation is done, polling every second until it is. That tab boots
 * through the root route, which rejects any pending approval when it is not
 * the notification window (`BoostScreen`: `isNotification || rejectApproval()`),
 * so the approval popup closes and the dapp gets 4001 "User rejected the
 * request". The tab arrives on the wallet's schedule, not onboarding's: a
 * connect request sent before it has booted is rejected by the wallet itself.
 *
 * Booted means the tab has left the root route for a screen (`#/main`, or
 * `#/welcome` when it booted before the vault existed); the rejection runs
 * once, on that boot.
 */
export async function waitForUnisatInstallTabBooted(onboardPage: Page, extensionId: string): Promise<void> {
  const context = onboardPage.context();
  const booted = new RegExp(`^chrome-extension://${extensionId}/index\\.html#/[a-z]`);
  await expect
    .poll(() => context.pages().some((p) => p !== onboardPage && booted.test(p.url())), {
      message: 'UniSat install tab did not boot past its root route',
    })
    .toBe(true);
}
