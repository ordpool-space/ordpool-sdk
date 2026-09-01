import { expect, Page } from '@playwright/test';

import { PASSWORD_BY_WALLET, TEST_MNEMONIC } from './wallet-test-vectors';

/**
 * Drive a Leather-family wallet through onboarding from the BIP-39 test seed to
 * a signed-in dashboard: welcome → "Use existing key" → 12 per-word seed inputs
 * → set password → dashboard (send/receive/balance/bitcoin).
 *
 * Leather AND its fork Cat21 Wallet share this exact flow (identical bundle
 * testids: `sign-in-link`, `set-or-enter-password-input`, `set-password-btn`),
 * so onboard-cat21wallet.ts delegates here. Shared by the e2e specs + the local
 * wallet-runner (matches onboard-okx.ts / onboard-phantom.ts).
 */
export async function onboardLeather(
  page: Page,
  extensionId: string,
  opts: { password?: string; mnemonic?: string } = {},
): Promise<void> {
  const password = opts.password ?? PASSWORD_BY_WALLET.leather;
  const mnemonic = opts.mnemonic ?? TEST_MNEMONIC;

  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sign-in-link')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('sign-in-link').click();

  const inputs = page.locator('input[type="text"], input[type="password"]');
  await expect(inputs.first()).toBeVisible({ timeout: 15_000 });
  const words = mnemonic.split(' ');
  for (let i = 0; i < words.length; i++) await inputs.nth(i).fill(words[i]);
  await page.getByRole('button', { name: /continue|sign in|restore|confirm/i }).first().click();

  const pwInput = page.getByTestId('set-or-enter-password-input');
  await expect(pwInput).toBeVisible({ timeout: 15_000 });
  await pwInput.click();
  await pwInput.pressSequentially(password, { delay: 15 });
  await page.getByTestId('set-password-btn').click();

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance') || t.includes('bitcoin');
  }, undefined, { timeout: 30_000, polling: 250 });
}
