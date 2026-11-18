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
/**
 * Click Continue on the address-type step until Security Tips shows.
 *
 * A Continue click there can first make Wizz derive the account's addresses
 * (the button shows ant-design's loading icon, the rows fill in) and leave the
 * step on screen, so a second click is the one that advances. After the
 * loading ends, the icon can stay in the DOM in its leave animation
 * (`ant-btn-loading-icon-motion-leave`) with its `aria-label="loading"`, which
 * names the button "loading Continue" in the accessibility tree. A failure's
 * attached aria snapshot and HTML showed exactly that: the button idle (no
 * `ant-btn-loading` class) and a role locator for "Continue" matching nothing,
 * so the second click waited for the whole bound.
 *
 * The button is therefore found by its text, which the icon does not change.
 * It counts as still pre-click while it is enabled and not loading, so
 * clickUntilEffect clicks again then and otherwise waits for the effect.
 */
export declare function continueAfterAddressType(page: Page, label: string): Promise<void>;
//# sourceMappingURL=onboard-wizz.d.ts.map