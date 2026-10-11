import { expect, Page } from '@playwright/test';
import { clickUntilEffect } from './click-until-effect';
import { waitForUnisatInstallTabBooted } from './onboard-unisat';

import { PASSWORD_BY_WALLET, TEST_MNEMONIC_WORDS } from './wallet-test-vectors';

/**
 * Drive Wizz (a UniSat fork) onboarding from the BIP-39 test seed to the
 * dashboard. Wizz's onboarding has NO data-testids, so this uses text + role
 * selectors. `addressTypeRowLabel` folds in the matrix variant (default Native
 * Segwit). Wizz is mainnet-only; roundtrip specs derive the regtest bcrt1
 * equivalents. Shared by the e2e specs + the local wallet-runner.
 */
export async function onboardWizz(
  page: Page,
  extensionId: string,
  opts: { addressTypeRowLabel?: string; password?: string; mnemonicWords?: string[] } = {},
): Promise<void> {
  const password = opts.password ?? PASSWORD_BY_WALLET.wizz;
  const words = opts.mnemonicWords ?? TEST_MNEMONIC_WORDS;
  const addressTypeRowLabel = opts.addressTypeRowLabel ?? 'Native Segwit (P2WPKH)';

  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByText('I already have a wallet', { exact: true })).toBeVisible();
  await page.getByText('I already have a wallet', { exact: true }).click();

  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible();
  const pwCount = await pwInputs.count();
  for (let i = 0; i < pwCount; i++) await pwInputs.nth(i).fill(password);
  await clickUntilEffect(
    page.getByRole('button', { name: /^continue$/i }).first(),
    page.getByText('Wizz Wallet', { exact: true }).first(),
    { label: 'wizz onboarding: continue after password' },
  );

  await expect(page.getByText('Wizz Wallet', { exact: true }).first()).toBeVisible();
  await page.getByText('Wizz Wallet', { exact: true }).first().click({ force: true });

  const mnemonicInputs = page.locator('input[type="text"], input[type="password"]');
  await expect(mnemonicInputs.first()).toBeVisible();
  for (let i = 0; i < words.length; i++) await mnemonicInputs.nth(i).fill(words[i]);
  await clickUntilEffect(
    page.getByRole('button', { name: /^continue$/i }).first(),
    page.getByText(addressTypeRowLabel, { exact: true }).first(),
    { label: 'wizz onboarding: continue after mnemonic' },
  );

  await expect(page.getByText(addressTypeRowLabel, { exact: true }).first()).toBeVisible();
  await page.getByText(addressTypeRowLabel, { exact: true }).first().click({ force: true });
  const continueBtn = page.getByRole('button', { name: /^continue$/i }).last();
  await continueBtn.scrollIntoViewIfNeeded();
  // The address-type row above re-renders on selection, so this button can be
  // replaced between the locator resolving and the click landing. Observed in
  // CI as "Security Tips: element(s) not found", one step from the cause.
  await clickUntilEffect(continueBtn, page.getByText('Security Tips', { exact: true }), {
    label: 'wizz onboarding: continue after address type',
  });

  await expect(page.getByText('Security Tips', { exact: true })).toBeVisible();
  const checkboxes = page.locator('label.ant-checkbox-wrapper');
  await expect(checkboxes).toHaveCount(3);
  const cbCount = await checkboxes.count();
  for (let i = 0; i < cbCount; i++) await checkboxes.nth(i).click();
  await page.getByRole('button', { name: /^ok$/i }).click();

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('receive') || t.includes('send') || t.includes('balance');
  }, undefined, { polling: 500 });

  // Wizz is a UniSat fork and opens the same install tab once its background
  // has initialised, on its own schedule, sometimes after onboarding has
  // returned. Its boot rejects a pending approval that is not the notification
  // window, so a connect sent before it booted fails with 4001 "User rejected
  // the request".
  await waitForUnisatInstallTabBooted(page, extensionId);
}
