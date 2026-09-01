import { type BrowserContext, type Page } from '@playwright/test';
/**
 * Wait for the Cat21 Wallet's getAddresses approval popup to open
 * in `context`, then click the approve button.
 *
 * Identified by the `get-addresses-approve-button` testid on a
 * chrome-extension:// page (see the wallet's OnboardingSelectors
 * bundle). Every cat21wallet spec that connects to the dapp goes
 * through this surface.
 */
export declare function approveCat21WalletConnectPopup(context: BrowserContext, knownPages: Set<Page>): Promise<void>;
interface ApproveCat21WalletSignPopupArgs {
    context: BrowserContext;
    /** Pages already known before the operation that opens the popup. */
    knownPages: Set<Page>;
    /** Optional callback used to capture a screenshot of the approval page. */
    screenshot?: (page: Page) => Promise<void>;
    /**
     * Optional content gate. When provided, the helper asserts that the
     * popup URL contains `sign-psbt` and one `signAtIndex=<n>` param
     * per listed index; the `psbt-signer-card` testid must be visible
     * before the confirm click. Used by the offer + transfer specs to
     * pin WHICH inputs the wallet is about to sign; mint + inscribe
     * (single signing input, no externally-driven index) omit it.
     *
     * Pass an array (e.g. `[0, 1]`) for the transfer flow where cat21-
     * wallet signs both inputs in ONE popup via the signAtIndex-array
     * RPC shape. Pass a single number when only one index is signed.
     */
    expectedSignAtIndex?: number | number[];
}
/**
 * Wait for the Cat21 Wallet's sign-PSBT popup to open in `context`,
 * optionally verify the URL and DOM content, and click the
 * Confirm/Sign/Approve button.
 *
 * `{ noWaitAfter: true }` on the click — the wallet self-closes its
 * sign-psbt popup the moment the confirm dispatch reaches the SW.
 * Playwright's default click awaits post-click stability, and that
 * race surfaces as "Target page, context or browser has been closed"
 * when the popup tears down mid-click. The close IS the success
 * signal here.
 *
 * After the click the approval page is added to `knownPages` so a
 * subsequent `waitForApprovalPopup` in the same spec doesn't
 * re-match this one.
 */
export declare function approveCat21WalletSignPopup(args: ApproveCat21WalletSignPopupArgs): Promise<void>;
export {};
//# sourceMappingURL=cat21wallet-sign-popup.d.ts.map