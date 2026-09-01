import { Page } from '@playwright/test';
/**
 * Drive UniSat onboarding from the BIP-39 test seed to the home tab.
 * Shared by the e2e specs AND the local wallet-runner (matches
 * onboard-okx.ts / onboard-phantom.ts / onboard-cat21wallet.ts).
 *
 * `addressTypeIndex` folds in the matrix variant: when set, the matching
 * address-type card is picked before continuing. UniSat is mainnet-only, so
 * roundtrip specs derive the regtest bcrt1 equivalents from the same pubkey.
 */
export declare function onboardUnisat(page: Page, extensionId: string, opts?: {
    addressTypeIndex?: number;
    password?: string;
    mnemonicWords?: string[];
}): Promise<void>;
//# sourceMappingURL=onboard-unisat.d.ts.map