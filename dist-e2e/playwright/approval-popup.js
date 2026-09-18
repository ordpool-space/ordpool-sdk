"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitForApprovalPopup = waitForApprovalPopup;
exports.closeLeftoverExtensionPages = closeLeftoverExtensionPages;
exports.approveWizzSignPopup = approveWizzSignPopup;
exports.clickApprovalButton = clickApprovalButton;
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
async function waitForApprovalPopup(opts) {
    const { context, knownPages, isApproval } = opts;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
        let settled = false;
        const finishOk = (p) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(p);
        };
        const finishErr = (err) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(err);
        };
        const tryPage = async (p) => {
            if (settled || knownPages.has(p))
                return;
            try {
                const res = await isApproval(p);
                if (res !== true)
                    return;
                // A CLOSING popup still satisfies "the confirm button is visible":
                // the DOM is alive while the window goes away. Handing that page back
                // means the caller's `click()` waits for the element to be visible,
                // enabled AND STABLE, never gets stable because the page is dying, and
                // fails with "Target page, context or browser has been closed". The
                // observed shape is a fast failure in specs that approve twice in
                // quick succession, passing on retry.
                //
                // So require the page to answer a round-trip before returning it. A
                // page that is going away cannot, and the search continues for the one
                // that is actually live. This is a liveness check rather than a delay:
                // nothing is waited out, the page either responds or it does not.
                await p.title();
                if (p.isClosed())
                    return;
                finishOk(p);
            }
            catch {
                // isApproval rejected (e.g. internal timeout), or the liveness probe
                // failed because the page went away. Don't abort the search — another
                // page may still match.
            }
        };
        const onPage = (p) => void tryPage(p);
        const timer = setTimeout(() => finishErr(new Error(`approval popup did not appear within ${timeoutMs}ms`)), timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            context.off('page', onPage);
        };
        context.on('page', onPage);
        for (const p of context.pages())
            void tryPage(p);
    });
}
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
async function closeLeftoverExtensionPages(context, keep) {
    const keepSet = new Set(keep);
    for (const p of context.pages()) {
        if (keepSet.has(p))
            continue;
        // OKX (and other wallets) tear their own pages down the instant they
        // auto-approve, so a page enumerated here can already be closing.
        // `p.url()` on a closed page throws "guid not bound" — uncaught, that
        // failed the whole spec during the connect/commit cleanup, before the
        // flow even reached the next sign. Skip closed pages and swallow a page
        // that closes between the isClosed() check and the url() read.
        if (p.isClosed())
            continue;
        try {
            if (!p.url().startsWith('chrome-extension://'))
                continue;
        }
        catch {
            continue;
        }
        await p.close().catch(() => undefined);
    }
}
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
async function approveWizzSignPopup(opts) {
    const popupTimeoutMs = opts.popupTimeoutMs ?? 120_000;
    const approval = await waitForApprovalPopup({
        context: opts.context,
        knownPages: opts.knownPages,
        timeoutMs: popupTimeoutMs,
        isApproval: async (p) => {
            await p.waitForURL(/notification\.html#\/approval/, { timeout: popupTimeoutMs });
            return true;
        },
    });
    await opts.onScreenshot?.(approval, 'sign-approval');
    await approval.waitForFunction(() => {
        const isSignButton = (el) => {
            const text = (el.textContent || '').trim();
            // Optional leading spinner glyph; rejects "Signed" and similar.
            return /^\s*[⠀-⣿•●]?\s*Sign\s*$/i.test(text);
        };
        const els = Array.from(document.querySelectorAll('button, [role="button"], div'));
        const candidate = els.find(isSignButton);
        if (!candidate)
            return null;
        const style = getComputedStyle(candidate);
        if (style.pointerEvents === 'none')
            return null;
        if (parseFloat(style.opacity) < 0.7)
            return null;
        candidate.click();
        return { text: candidate.textContent };
    }, undefined, { timeout: opts.signTimeoutMs ?? 60_000, polling: 250 });
    // The popup auto-closes once the wallet processes the click, so this is
    // best-effort by design.
    await opts.onScreenshot?.(approval, 'after-sign-click').catch(() => undefined);
}
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
async function clickApprovalButton(button, page, timeoutMs = 15_000) {
    try {
        await button.click({ timeout: timeoutMs });
    }
    catch (e) {
        const message = e.message ?? '';
        const targetGone = /Target (page|closed)|context or browser has been closed|has been closed/i.test(message);
        if (targetGone && page.isClosed()) {
            return;
        }
        throw e;
    }
}
//# sourceMappingURL=approval-popup.js.map