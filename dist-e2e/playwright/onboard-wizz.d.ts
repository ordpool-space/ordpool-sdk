import { Page } from '@playwright/test';
/**
 * Drive Wizz (a UniSat fork) onboarding from the BIP-39 test seed to the
 * dashboard. Wizz's onboarding has NO data-testids, so this uses text + role
 * selectors. `addressTypeRowLabel` folds in the matrix variant (default Native
 * Segwit). Wizz is mainnet-only; roundtrip specs derive the regtest bcrt1
 * equivalents. Shared by the e2e specs + the local wallet-runner.
 */
export declare function onboardWizz(page: Page, extensionId: string, opts?: {
    addressTypeRowLabel?: string;
    password?: string;
    mnemonicWords?: string[];
}): Promise<void>;
//# sourceMappingURL=onboard-wizz.d.ts.map