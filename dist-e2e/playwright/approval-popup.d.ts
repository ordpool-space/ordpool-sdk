import type { BrowserContext, Page } from '@playwright/test';
/**
 * Wait for a wallet-extension approval popup to open in the given
 * browser context, identified by a caller-supplied predicate.
 *
 * Event-driven, no polling sleeps. Strategy:
 *   - For every chrome-extension page (existing + new via
 *     `context.on('page')`), kick off `isApproval(page)`.
 *   - Each `isApproval` blocks until it observes the approval surface
 *     on that page (via `page.waitForURL` for URL-anchored matches
 *     or `locator.waitFor({state:'visible'})` for testid/role
 *     matches). When ANY page's `isApproval` resolves truthy, that
 *     page wins and the outer promise resolves with it.
 *
 * Caller patterns:
 *   - URL-anchored (Unisat / Wizz):
 *       isApproval: async p => {
 *         await p.waitForURL(/notification\.html#\/approval/, { timeout: 60_000 });
 *         return true;
 *       }
 *   - Element-anchored (Leather testid, Xverse role+name):
 *       isApproval: async p => {
 *         await p.getByTestId('…approve-button')
 *                .waitFor({ state: 'visible', timeout: 60_000 });
 *         return true;
 *       }
 *
 * `isApproval` may throw (e.g. its internal timeout fires) — the
 * helper swallows the throw and keeps waiting on the OTHER pages,
 * which is the right behaviour: one page failing the match shouldn't
 * abort the search.
 *
 * The outer `timeoutMs` is the deadline beyond which we reject. It
 * is NOT a poll interval — it's a hard rejection timer enforced via
 * a single setTimeout.
 */
export declare function waitForApprovalPopup(opts: {
    context: BrowserContext;
    knownPages: Set<Page>;
    isApproval: (p: Page) => boolean | Promise<boolean>;
    timeoutMs?: number;
}): Promise<Page>;
/**
 * Close every chrome-extension page in the context except those
 * in `keep`. Defensive — wallets like Xverse, OKX, Phantom, Alby
 * routinely leave a "Connected" dashboard tab open after approval,
 * which then races against the next sign popup (sometimes the
 * wallet reuses that tab; sometimes it opens a fresh one). The
 * `knownPages` filter inside `waitForApprovalPopup` excludes the
 * dashboard, so if the wallet reuses it, the test times out
 * waiting for a sign popup that's actually rendering on the
 * filtered tab.
 *
 * Always call this AFTER the connect/approval result resolved —
 * we never close a popup that's still mid-handshake with the
 * wallet's SW, only ones that already did their job.
 */
export declare function closeLeftoverExtensionPages(context: BrowserContext, keep: Iterable<Page>): Promise<void>;
/**
 * Click Sign in a Wizz/Unisat-family approval popup, once the button is really
 * enabled.
 *
 * The predicate is deliberately LOOSE about the button's text. While the wallet
 * analyses the PSBT the button is disabled and covered by a spinner overlay, so
 * its `textContent` can be a spinner glyph plus whitespace around the word, and
 * a matcher pinned to exactly "Sign" never fires even after the button becomes
 * clickable. That failure is indistinguishable from a button that never enables:
 * both are a timeout. The regex therefore accepts an optional spinner character,
 * while still rejecting neighbouring text like "Signed".
 *
 * Enabledness is read from computed style (`pointerEvents`, `opacity`) rather
 * than a disabled attribute, and the click happens INSIDE the same
 * `page.evaluate` as the check, so the button cannot change state between the
 * two.
 *
 * Pass `onScreenshot` to capture the popup before the wait and after the click;
 * the post-click call is best-effort because the popup auto-closes.
 */
export declare function approveWizzSignPopup(opts: {
    context: BrowserContext;
    knownPages: Set<Page>;
    /** Wait for the popup itself. Default 120s. */
    popupTimeoutMs?: number;
    /** Wait for the Sign button to become clickable. Default 60s. */
    signTimeoutMs?: number;
    onScreenshot?: (page: Page, name: string) => Promise<void>;
}): Promise<void>;
/**
 * Click an approval button that DISMISSES ITS OWN PAGE.
 *
 * A wallet closes its approval popup the moment it accepts the click, and
 * Playwright's post-click bookkeeping then runs against a target that no longer
 * exists, throwing "Target page, context or browser has been closed". From the
 * click's own error there is no way to tell that outcome, which is SUCCESS,
 * apart from a click that never landed.
 *
 * So the close is tolerated only when the page is genuinely gone, which is what
 * an accepted approval looks like. This hides nothing: if the click did not
 * land, the wallet never signs, and the spec's own downstream assertion (a
 * broadcast txid, a confirmed transaction, a success panel) fails with a
 * message about the thing that actually matters. Any other error still throws.
 */
export declare function clickApprovalButton(button: {
    click: (opts?: {
        timeout?: number;
    }) => Promise<void>;
}, page: {
    isClosed: () => boolean;
}, timeoutMs?: number): Promise<void>;
//# sourceMappingURL=approval-popup.d.ts.map