import { BrowserContext, Page } from '@playwright/test';
export interface WalletOnboarder {
    /** Onboard the wallet in the given context (extensionId = the loaded ext). */
    onboard: (context: BrowserContext, extensionId: string) => Promise<void>;
    /** The onboarding password this wallet needs. */
    password: string;
    /** A VENDOR limitation to surface (a wallet bug, not something we fix). */
    caveat?: string;
}
export declare const walletOnboarders: Record<string, WalletOnboarder>;
/** Wallet names with a reusable onboarder (every wallet the E2E supports). */
export declare const onboardableWallets: string[];
/**
 * The page to onboard a freshly installed extension on: the tab the extension
 * opened itself (its `chrome-extension://<id>/...` onboarding), or a new blank
 * page when it opened none within the probe. Other tabs (a vendor's marketing
 * page) are ignored by the URL filter.
 *
 * Only the probe running out means "no tab"; any other failure (the context
 * closed) is thrown.
 */
export declare function extensionOnboardingPage(context: BrowserContext, extensionId: string): Promise<Page>;
//# sourceMappingURL=wallet-onboarders.d.ts.map