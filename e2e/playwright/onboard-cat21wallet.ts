import { expect, Page } from '@playwright/test';

// The well-known BIP-39 test vector + Cat21 Wallet's onboarding password (its
// zxcvbn strength meter rejects weaker strings). Deliberately unsuited for real
// use — anyone with the seed observes the wallet.
const DEFAULT_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const DEFAULT_PASSWORD = 'correct-horse-battery-staple-Tr0ub4dor-9876';

/**
 * Drive Cat21 Wallet onboarding from the BIP-39 test seed to a signed-in
 * dashboard: welcome → "Use existing key" → 12 mnemonic words → set password →
 * dashboard (send/receive/balance/bitcoin).
 *
 * Shared by the e2e specs AND the local wallet-runner so both use ONE onboard
 * path (matches onboard-okx.ts / onboard-phantom.ts). Uses the bundle's stable
 * data-testids (`sign-in-link`, `set-or-enter-password-input`, `set-password-btn`).
 */
export async function onboardCat21Wallet(
  page: Page,
  extensionId: string,
  mnemonic: string = DEFAULT_MNEMONIC,
  password: string = DEFAULT_PASSWORD,
): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sign-in-link')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('sign-in-link').click();

  const inputs = page.locator('input[type="text"], input[type="password"]');
  await expect(inputs.first()).toBeVisible({ timeout: 15_000 });
  const words = mnemonic.split(' ');
  for (let i = 0; i < 12; i++) {
    await inputs.nth(i).fill(words[i]);
  }
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
