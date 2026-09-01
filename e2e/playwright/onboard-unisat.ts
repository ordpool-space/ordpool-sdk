import { expect, Page } from '@playwright/test';

import { PASSWORD_BY_WALLET, TEST_MNEMONIC_WORDS } from './wallet-test-vectors';

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

  await expect(page.getByTestId('welcome-title')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('import-wallet-button').click();

  await expect(page.getByTestId('create-password-input')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('create-password-input').fill(password);
  await page.getByTestId('create-password-confirm-input').fill(password);
  await page.getByTestId('create-password-continue-button').click();

  await expect(page.getByTestId('restore-wallet-type-option-0')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('restore-wallet-type-option-0').click();

  await expect(page.getByTestId('mnemonic-import-word-0')).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < words.length; i++) {
    await page.getByTestId(`mnemonic-import-word-${i}`).fill(words[i]);
  }
  await page.getByTestId('mnemonic-import-continue-button').click();

  if (opts.addressTypeIndex !== undefined) {
    const card = page.getByTestId(`address-type-card-${opts.addressTypeIndex}`);
    if (await card.isVisible({ timeout: 5_000 }).catch(() => false)) await card.click();
  }
  const addressTypeContinue = page.getByTestId('address-type-continue-button');
  if (await addressTypeContinue.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await addressTypeContinue.click();
  }

  const noticeCheckbox = page.getByTestId('notice-checkbox-1');
  if (await noticeCheckbox.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await noticeCheckbox.click();
    const noticeOk = page.getByTestId('notice-ok-button');
    if (await noticeOk.isEnabled({ timeout: 3_000 }).catch(() => false)) await noticeOk.click();
  }

  await expect(page.getByTestId('tab-home')).toBeVisible({ timeout: 30_000 });
}
