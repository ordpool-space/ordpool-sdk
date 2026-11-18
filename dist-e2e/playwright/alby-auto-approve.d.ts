import { BrowserContext } from '@playwright/test';
/**
 * Auto-approve every Alby extension popup the context spawns (the
 * `alby.enable()` permission prompt and, on the SW-bypass specs, any
 * stray confirm surface).
 *
 * Two Alby quirks make a naive visible-then-click flaky, and both are
 * handled with STATE waits, not timeouts:
 *   - On regtest Alby fires a balance fetch that fails and shows an
 *     error toast occluding clicks for a few seconds. `click({ trial:
 *     true })` performs the full actionability check (visible, stable,
 *     enabled, RECEIVES EVENTS) without clicking, so it resolves the
 *     moment the toast stops intercepting the pointer.
 *   - Alby hydrates its React handlers after first paint; a click that
 *     lands pre-hydration is silently absorbed. Actionability cannot
 *     see handler attachment, so the click retries until the popup
 *     closes — the success signal of an accepted approval.
 */
export interface AlbyAutoApproveHandle {
    /** How many popups this listener clicked through: each one CLOSED after its clicks. */
    approved: () => number;
    /** Every extension page it considered, with the first line it was showing. */
    seen: () => string[];
    /**
     * Every prompt it could not approve, with why: the popup was still open
     * after the last click (and what that click answered), or a wait or read on
     * it failed.
     */
    failures: () => string[];
}
export declare function installAlbyAutoApprove(context: BrowserContext, opts?: {
    labels?: RegExp;
}): AlbyAutoApproveHandle;
//# sourceMappingURL=alby-auto-approve.d.ts.map