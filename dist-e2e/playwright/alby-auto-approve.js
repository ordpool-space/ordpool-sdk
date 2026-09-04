"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installAlbyAutoApprove = installAlbyAutoApprove;
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
function installAlbyAutoApprove(context, opts = {}) {
    const labels = opts.labels ?? /^(connect|allow|confirm|approve|sign)$/i;
    context.on('page', async (popup) => {
        try {
            await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 });
            if (!popup.url().startsWith('chrome-extension://'))
                return;
            const btn = popup.locator('button', { hasText: labels }).first();
            await btn.waitFor({ state: 'visible', timeout: 15_000 });
            await btn.click({ trial: true, timeout: 15_000 });
            for (let attempt = 0; attempt < 8 && !popup.isClosed(); attempt++) {
                await btn.click({ timeout: 2_000 }).catch(() => undefined);
                await popup.waitForEvent('close', { timeout: 1_500 }).catch(() => undefined);
            }
        }
        catch { /* best-effort approve; the spec's own asserts catch a missed popup */ }
    });
}
//# sourceMappingURL=alby-auto-approve.js.map