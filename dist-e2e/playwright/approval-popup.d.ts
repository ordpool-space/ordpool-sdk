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
//# sourceMappingURL=approval-popup.d.ts.map