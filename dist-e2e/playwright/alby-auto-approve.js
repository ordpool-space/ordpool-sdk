"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installAlbyAutoApprove = installAlbyAutoApprove;
/**
 * Probe: how long one click on the approval button gets to land. A click that
 * Alby absorbs before hydration is the expected miss here, and the loop
 * clicks again.
 */
const ALBY_CLICK_PROBE_MS = 2_000;
/**
 * Probe: how long the popup gets to close after one click. An accepted
 * approval closes it well within this; a click absorbed before hydration
 * leaves it open, the expected miss that sends the loop round again.
 */
const ALBY_CLOSE_PROBE_MS = 1_500;
function installAlbyAutoApprove(context, opts = {}) {
    const labels = opts.labels ?? /^(connect|allow|confirm|approve|sign)$/i;
    let approved = 0;
    const seen = [];
    const failures = [];
    const handle = async (popup) => {
        const label = () => popup.url().slice(0, 60);
        try {
            await popup.waitForLoadState('domcontentloaded');
            // Alby draws every permission and confirm prompt on `prompt.html`. Any
            // other page (the options tab left open by onboarding, the dapp) never
            // shows an approval button, and waiting on it would only run out the
            // per-wait bound.
            if (!/^chrome-extension:\/\/[^/]+\/prompt\.html/.test(popup.url()))
                return;
            const first = await popup.locator('body').innerText();
            seen.push(`${label()} => ${first.trim().split('\n')[0]?.slice(0, 60) || '<empty>'}`);
            const btn = popup.locator('button', { hasText: labels }).first();
            await btn.waitFor({ state: 'visible' });
            await btn.click({ trial: true });
            // The popup closing is the only proof an approval was accepted, so the
            // loop decides on that state. A click that throws because the popup
            // closed under it is that success; a click that throws while the popup
            // stays open is the pre-hydration miss, kept as the reason if no later
            // click lands.
            let lastClick = 'not clicked';
            for (let attempt = 0; attempt < 8 && !popup.isClosed(); attempt++) {
                const closed = popup.waitForEvent('close', { timeout: ALBY_CLICK_PROBE_MS + ALBY_CLOSE_PROBE_MS })
                    .then(() => true, () => false);
                lastClick = await btn.click({ timeout: ALBY_CLICK_PROBE_MS }).then(() => 'clicked', (err) => `click failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
                await closed;
            }
            if (popup.isClosed()) {
                approved += 1;
            }
            else {
                failures.push(`${label()} => still open after 8 clicks, last: ${lastClick}`);
            }
        }
        catch (err) {
            failures.push(`${label()} => ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
        }
    };
    context.on('page', (p) => void handle(p));
    // Alby may reuse an extension page that is ALREADY open rather than opening a
    // new one, and a listener on 'page' alone never sees that. Same shape that
    // made the okx sign-message wait miss its popup.
    for (const p of context.pages())
        void handle(p);
    return { approved: () => approved, seen: () => [...seen], failures: () => [...failures] };
}
//# sourceMappingURL=alby-auto-approve.js.map