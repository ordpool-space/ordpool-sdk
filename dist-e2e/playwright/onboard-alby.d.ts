import { Page } from '@playwright/test';
/**
 * Seed an Alby account from the BIP-39 test seed — PROGRAMMATICALLY via Alby's
 * service-worker message bus (setPassword → addAccount → setMnemonic), NOT a UI
 * onboard: Alby has no restore-from-seed onboarding UI, and its popup confirm()
 * never resolves headless. Envelope shape per Alby's common/lib/msg.ts. Returns
 * the created accountId. Shared by the e2e specs + the local wallet-runner.
 */
export declare function seedAlbyAccount(page: Page, opts?: {
    bitcoinNetwork?: 'bitcoin' | 'regtest';
    password?: string;
    mnemonic?: string;
}): Promise<string>;
//# sourceMappingURL=onboard-alby.d.ts.map