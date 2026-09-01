import { Page } from '@playwright/test';
/**
 * Onboard Cat21 Wallet from the BIP-39 test seed to a signed-in dashboard.
 *
 * Cat21 Wallet is a Leather fork with the IDENTICAL onboarding flow (same
 * bundle testids), so this delegates to onboardLeather. Kept as its own named
 * export so consumers say the wallet they mean; shared by the e2e specs + the
 * local wallet-runner.
 */
export declare function onboardCat21Wallet(page: Page, extensionId: string, opts?: {
    mnemonic?: string;
    password?: string;
}): Promise<void>;
//# sourceMappingURL=onboard-cat21wallet.d.ts.map