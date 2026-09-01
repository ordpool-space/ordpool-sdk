import { BrowserContext } from '@playwright/test';
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
//# sourceMappingURL=wallet-onboarders.d.ts.map