import { BrowserContext } from '@playwright/test';
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