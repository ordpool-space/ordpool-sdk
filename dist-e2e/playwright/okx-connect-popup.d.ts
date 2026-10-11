import type { BrowserContext, Page } from '@playwright/test';
/**
 * The page OKX shows a dapp's connect request on: `notification.html` or
 * `popup.html`, hash route `/connect` (its UI's route constant), with the
 * request after it (`#/connect/<id>`). `/connect-site` is a different route
 * and does not match.
 */
export declare const OKX_CONNECT_URL: RegExp;
/**
 * `isApproval` for OKX's connect request: the page is on `OKX_CONNECT_URL`
 * (now or after a later navigation) and shows its Connect button. The URL
 * keeps out the sign popup OKX may open during a connect; the button is what
 * the caller clicks.
 */
export declare const isOkxConnectApproval: (page: Page) => Promise<boolean>;
/**
 * Find OKX's connect request on any page of the context, the ones open before
 * the request included.
 *
 * OKX 4.1.0 reuses its open popup window: `showPopup` focuses the window it
 * already has (`this.popupId`) and opens a new one only when there is none, so
 * the request can arrive by navigation inside a page that existed before the
 * dapp asked. A `knownPages` filter of the pages open at that moment excludes
 * exactly that page, so this search has none; the URL decides instead.
 */
export declare function waitForOkxConnectApproval(opts: {
    context: BrowserContext;
}): Promise<Page>;
/**
 * Approve OKX's connect request wherever it shows, and require the page to
 * close: OKX closes it the moment it accepts, so the close proves the click
 * landed. Returns the page it approved on.
 */
export declare function approveOkxConnectPopup(opts: {
    context: BrowserContext;
}): Promise<Page>;
//# sourceMappingURL=okx-connect-popup.d.ts.map