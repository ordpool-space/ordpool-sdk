import { Page } from '@playwright/test';

import { onboardLeather } from './onboard-leather';
import { PASSWORD_BY_WALLET } from './wallet-test-vectors';

/**
 * Onboard Cat21 Wallet from the BIP-39 test seed to a signed-in dashboard.
 *
 * Cat21 Wallet is a Leather fork with the IDENTICAL onboarding flow (same
 * bundle testids), so this delegates to onboardLeather. Kept as its own named
 * export so consumers say the wallet they mean; shared by the e2e specs + the
 * local wallet-runner.
 */
export async function onboardCat21Wallet(
  page: Page,
  extensionId: string,
  mnemonic?: string,
  password?: string,
): Promise<void> {
  return onboardLeather(page, extensionId, {
    mnemonic,
    password: password ?? PASSWORD_BY_WALLET.cat21wallet,
  });
}
