import { Locator, Page } from '@playwright/test';
import { boundByE2eTimeout, e2eExpect as expect } from './e2e-expect';

import { PASSWORD_BY_WALLET, TEST_MNEMONIC_WORDS } from './wallet-test-vectors';
import { cdpClick } from './cdp-click';
import { waitForPageShowing } from './approval-popup';

/**
 * Drive Phantom v26 onboarding from welcome to the "You're good to go"
 * completion screen. Multi-page flow (CI iterations 22-30, 2026-05-31):
 *
 *   - Welcome → "I Already Have a Wallet" (anti-automation filter,
 *     needs raw CDP Input.dispatchMouseEvent).
 *   - Import-a-wallet picker → "Import Recovery Phrase".
 *   - 12 mnemonic input boxes → Import Wallet.
 *   - "Import Accounts — Finding Accounts with Activity" loading,
 *     transitions to "We found N accounts with activity" result. The
 *     result may render on a NEW page (Phantom replaces the tab); poll
 *     context.pages() for the result-state marker.
 *   - Continue (rendered as a styled <div>, not a real button) once
 *     Phantom finishes deriving account info (opacity gate).
 *   - YET another new page for "Create a password" — switch reference.
 *   - Password + Confirm Password fields; the Reach UI custom-checkbox
 *     Terms (`tickPhantomTerms`); Continue.
 *   - "You're good to go!" completion screen with a "Get Started" CTA.
 *     Onboarding is complete at this screen: the wallet is restored and
 *     unlocked. This returns there; callers open popup.html themselves,
 *     which does not depend on Get Started.
 */
export async function onboardPhantom(
  page: Page,
  extensionId: string,
  opts: { password?: string; mnemonicWords?: string } = {},
): Promise<void> {
  boundByE2eTimeout(page);
  const password = opts.password ?? PASSWORD_BY_WALLET.phantom;
  const mnemonicWords = (opts.mnemonicWords ?? TEST_MNEMONIC_WORDS.join(' ')).split(' ');
  const mnemonic = mnemonicWords.join(' ');

  if (page.url() === 'about:blank') {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'networkidle' });
  }

  const importBtn = page.getByRole('button', { name: 'I Already Have a Wallet' });
  await expect(importBtn).toBeVisible();
  await cdpClick(page, importBtn, 'the "I Already Have a Wallet" button');

  const recoveryBtn = page.getByRole('button', { name: /Import Recovery Phrase/i });
  await expect(recoveryBtn).toBeVisible();
  await cdpClick(page, recoveryBtn, 'the "Import Recovery Phrase" button');

  const mnemonicInputs = page.locator('input, textarea');
  await expect(mnemonicInputs.first()).toBeVisible();
  const inputCount = await mnemonicInputs.count();
  if (inputCount >= 12) {
    for (let i = 0; i < mnemonicWords.length; i++) {
      await mnemonicInputs.nth(i).fill(mnemonicWords[i]);
    }
  } else {
    await mnemonicInputs.first().fill(mnemonic);
  }
  const confirmAfterMnemonic = page.getByRole('button', { name: /^import wallet$/i });
  await expect(confirmAfterMnemonic).toBeEnabled();
  await confirmAfterMnemonic.click();

  // The import result, on whichever page shows it: Phantom replaces the tab
  // for it in some releases and renders it in place in others. Its heading is
  // "We found N accounts with activity" or "We found 1 account", depending on
  // what Phantom's account scan returned.
  const ctx = page.context();
  page = await waitForPageShowing({ context: ctx, text: /We found \d+ accounts?\b/i });
  await page.waitForFunction(() => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], div'));
    const candidate = els.find(el => (el.textContent || '').trim() === 'Continue');
    if (!candidate) return false;
    if (candidate.getAttribute('aria-disabled') === 'true') return false;
    if ((candidate as HTMLElement).hasAttribute('disabled')) return false;
    if (parseFloat(getComputedStyle(candidate).opacity) < 0.7) return false;
    return true;
  }, undefined, { polling: 500 });
  const importAccountsContinue = page.getByText('Continue', { exact: true }).first();
  await cdpClick(page, importAccountsContinue, 'the import-accounts Continue button');

  // "Create a password", again on whichever page shows it.
  page = await waitForPageShowing({ context: ctx, text: /Create a password/i });

  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible();
  await pwInputs.nth(0).fill(password);
  await pwInputs.nth(1).fill(password);

  await tickPhantomTerms(page);

  await page.waitForFunction(() => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], div'));
    const candidate = els.find(el => (el.textContent || '').trim() === 'Continue');
    if (!candidate) return false;
    if (candidate.getAttribute('aria-disabled') === 'true') return false;
    if ((candidate as HTMLElement).hasAttribute('disabled')) return false;
    if (parseFloat(getComputedStyle(candidate).opacity) < 0.7) return false;
    return true;
  }, undefined, { polling: 500 });
  const pwContinue = page.getByText('Continue', { exact: true }).first();
  await cdpClick(page, pwContinue, 'the password Continue button');

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes("you're good to go") || t.includes('get started')
      || t.includes('send') || t.includes('receive') || t.includes('balance');
  }, undefined, { polling: 500 });
}

/**
 * Tick the Terms of Service box on Phantom's "Create a password" screen.
 *
 * The box is a Reach UI custom checkbox: the `<input>` is invisible and takes
 * no pointer events, and the visible 22 px square is its container span, which
 * is what a person clicks. The click is proven by the input's `aria-checked`.
 */
export async function tickPhantomTerms(page: Page): Promise<void> {
  const testId = 'onboarding-form-terms-of-service-checkbox';
  await tickPhantomTermsControls({
    box: page.locator('[data-reach-custom-checkbox-container]').filter({ has: page.getByTestId(testId) }),
    checked: page.locator(`[data-testid="${testId}"][aria-checked="true"]`),
  });
}

/** `tickPhantomTerms` on its two controls: the visible box, and the input once checked. */
export async function tickPhantomTermsControls(c: {
  box: Pick<Locator, 'click'>;
  checked: Pick<Locator, 'waitFor'>;
}): Promise<void> {
  await c.box.click();
  await c.checked.waitFor({ state: 'attached' });
}
