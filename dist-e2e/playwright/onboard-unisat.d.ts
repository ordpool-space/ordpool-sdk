import { Page } from '@playwright/test';
/**
 * Dismiss UniSat's "a new version is available" modal.
 *
 * The pinned extension asks UniSat's server whether a newer build exists, so
 * the modal appears on the first dashboard open as soon as upstream ships a
 * release past the pin, and it is layered ABOVE the compatibility notice.
 * Playwright then reports the notice checkbox as visible, enabled and stable
 * while `.row-container` from `.popover-container` intercepts every click, so
 * the failure names the checkbox and not the thing covering it.
 *
 * The modal carries no data-testid, so it is anchored on the one string only
 * it contains; "Skip" alone would also match the notice below it.
 */
export declare function dismissUnisatUpdateNag(page: Page): Promise<void>;
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