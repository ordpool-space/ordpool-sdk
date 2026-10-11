import { BrowserContext, Locator, Page } from '@playwright/test';
/**
 * Wallet 1 on Xverse's "Select a wallet to restore" picker, in either form it
 * takes. With account data from Xverse's backend the card offers "See
 * accounts"; when that lookup fails ("We couldn't retrieve account data due to
 * network issues") the card is a plain "Wallet 1 Account-based" button. Both
 * restore the same first account, and the Confirm that follows is the same.
 */
export declare function xverseRestorePickerWallet1(page: Page): Locator;
/** Drive Xverse onboarding from the BIP-39 test seed to a restored wallet. */
export declare function onboardXverse(context: BrowserContext, extensionId: string, opts?: {
    password?: string;
    mnemonic?: string;
}): Promise<void>;
/** Switch a just-onboarded Xverse to Bitcoin Regtest (Testnet mode + Regtest). */
export declare function primeAndSwitchToRegtest(context: BrowserContext, extensionId: string): Promise<void>;
/**
 * Override the built-in Regtest network's electrsApiUrl so Xverse broadcasts to
 * our local electrs instead of the default sBTC mempool. Xverse stores networks
 * in chrome.storage.local under `persistentStore::networks` as JSON.
 */
export declare function overrideRegtestElectrsUrl(context: BrowserContext, extensionId: string, electrsUrl: string): Promise<void>;
//# sourceMappingURL=onboard-xverse.d.ts.map