import type { BrowserContext } from '@playwright/test';
/**
 * The vendor web page OKX Wallet (v4.1.0) opens in a normal browser tab during
 * onboarding, right after the import-wallet click.
 */
export declare const OKX_WELCOME_PAGE_URL = "https://web3.okx.com/extension";
/**
 * Keep OKX Wallet's vendor website out of the test: the welcome tab the
 * extension opens is answered locally with an empty document.
 *
 * That tab is `https://web3.okx.com/extension`, a full OKX marketing page. It
 * is a normal web page, so `installContextErrorGuard` watches it, and on the
 * CI runner it produced every browser error of the OKX lane (ordpool run
 * 38057580518, `cat21-mint-okx-regtest`, read from its trace): eight
 * `net::ERR_FAILED` console errors, each a fetch of `chrome-extension://invalid/`
 * by the page's own scripts, and `wss://jpushws.okx.com/` WebSocket handshakes
 * answered 502 and 503. The same page also loads contentmx.okcoin.com,
 * h.online-metrix.net, jpush.okx.com, wsdexpri.okx.com and
 * geolocation.onetrust.com. None of it is ours and none of it is regtest.
 * Onboarding and signing do not need the tab: every OKX step runs on the
 * extension's own `chrome-extension://` pages. `onboardOkx` scans the text of
 * every open page, and in that run its "Start your Web3 journey" scan matched
 * the marketing page, found no button there, and finished on the extension
 * page. With the document answered locally none of those requests is made and
 * the tab carries no text to match.
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
export declare function installOkxOfflineRoutes(context: BrowserContext): Promise<void>;
//# sourceMappingURL=okx-offline-routes.d.ts.map