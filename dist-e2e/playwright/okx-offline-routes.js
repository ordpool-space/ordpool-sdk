"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OKX_WELCOME_PAGE_URL = void 0;
exports.installOkxOfflineRoutes = installOkxOfflineRoutes;
/**
 * The vendor web page OKX Wallet (v4.1.0) opens in a normal browser tab during
 * onboarding, right after the import-wallet click.
 */
exports.OKX_WELCOME_PAGE_URL = 'https://web3.okx.com/extension';
/** Stand-in document for the welcome tab: no scripts, no subresources. */
const OFFLINE_WELCOME_HTML = '<!doctype html><meta charset="utf-8"><title>OKX welcome page (offline)</title>';
const isWelcomePage = (url) => url.origin === 'https://web3.okx.com' && url.pathname === '/extension';
/**
 * Keep OKX Wallet's vendor website out of the test: the welcome tab the
 * extension opens is answered locally with an empty document.
 *
 * That tab is `https://web3.okx.com/extension`, a full OKX marketing page. It
 * is a normal web page, so `installContextErrorGuard` watches it, and its own
 * scripts log `net::ERR_FAILED` (fetches of `chrome-extension://invalid/`) and
 * failed `wss://jpushws.okx.com/` handshakes. It also loads
 * contentmx.okcoin.com, h.online-metrix.net, jpush.okx.com, wsdexpri.okx.com
 * and geolocation.onetrust.com. None of it is ours and none of it is regtest.
 * Onboarding and signing do not need the tab: every OKX step runs on the
 * extension's own `chrome-extension://` pages, and with the document answered
 * locally the tab carries no text for `onboardOkx`'s page scan to match.
 *
 * Not shielded: the extension pages' own calls to wallet.okx.com,
 * static.okx.com and wsdexpri.okx.com. The sign popup reads
 * `priapi/v2/wallet/tx/preExecTransactionv2`, `priapi/v1/wallet/tx/utxo/info`
 * and `priapi/v1/wallet/tx/dapp/sign/prompt` there, so answering them needs
 * response shapes captured from a run, the way `installWizzOfflineRoutes`
 * does for Wizz. They are outside the browser-error guard (extension pages).
 * `recordWalletBackendRequests` lists them.
 *
 * Install right after the context launches, before onboarding. A welcome tab
 * that is already open is reloaded so it picks up the local document.
 */
async function installOkxOfflineRoutes(context) {
    await context.route(isWelcomePage, (route) => route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: { 'cache-control': 'no-store' },
        body: OFFLINE_WELCOME_HTML,
    }));
    for (const page of context.pages()) {
        if (isWelcomePage(new URL(page.url()))) {
            await page.goto(exports.OKX_WELCOME_PAGE_URL, { waitUntil: 'domcontentloaded' });
        }
    }
}
//# sourceMappingURL=okx-offline-routes.js.map