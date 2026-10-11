import type { BrowserContext } from '@playwright/test';
/**
 * The vendor web page OKX Wallet (v4.1.0) opens in a normal browser tab during
 * onboarding, right after the import-wallet click.
 */
export declare const OKX_WELCOME_PAGE_URL = "https://web3.okx.com/extension";
/**
 * Every backend OKX Wallet (v4.1.0) calls from its service worker and its
 * pages, as recorded on the okx lane: its wallet API on `wallet.okx.com` and
 * the mirror `wallet.okex.org` (`priapi/*`, `v1/deposit/plugin/*`, the
 * `et/priapi/xweb` telemetry, the `apmfe` error reports), the CDNs
 * `static.okx.com` and `static.coinall.ltd` (translations, remote config,
 * logos), the heartbeat failover hosts (`web3.okx.com`, `wallet.ouxyi.cash`,
 * `web3.ouchyi.bid`, `web3.chouyi.pink`) and its DNS-over-HTTPS lookups
 * (`www.okx-httpdns.com`, `www.okx-doh.com`, and the two IP addresses the
 * bundle hardcodes, `47.57.9.204` and `47.75.96.239`).
 */
export declare const OKX_VENDOR_HOSTS: RegExp;
/**
 * `POST /priapi/v2/wallet/tx/preExecTransactionv2` for a `signPsbt` request,
 * as the server answered every one the okx-* specs sent on 2026-10-11: no
 * popup notices, no simulated transaction.
 */
export declare const OKX_PRE_EXEC_ANSWER: {
    popupInfoList: never[];
    txInfo: null;
};
/**
 * Keep OKX Wallet's vendor backends out of the test: the welcome tab the
 * extension opens is answered locally with an empty document, the sign
 * popup's pre-execution check with the server's captured answer, and every
 * other request to an OKX host (`OKX_VENDOR_HOSTS`) is aborted at once.
 *
 * The welcome tab is `https://web3.okx.com/extension`, a full OKX marketing
 * page. It is a normal web page, so `installContextErrorGuard` watches it, and
 * its own scripts would load OKX's trackers and websockets. Onboarding and
 * signing do not need it: every OKX step runs on the extension's own
 * `chrome-extension://` pages, and with the document answered locally the tab
 * carries no text for `onboardOkx`'s page scan to match.
 *
 * One request gates the UI: the sign popup's pre-execution check
 * (`POST priapi/v2/wallet/tx/preExecTransactionv2`). When it fails the popup
 * reads "Unable to submit your transaction. Check your network connection and
 * try again." and keeps Confirm disabled, so it is answered with the server's
 * captured answer (`OKX_PRE_EXEC_ANSWER`). Nothing else does: the okx lane
 * passes with every other OKX request aborted and every host except localhost
 * unreachable, the popup's transaction summary
 * (`priapi/v1/wallet/tx/utxo/info`), `priapi/v1/wallet/tx/dapp/sign/prompt`
 * and the URL and risk checks included.
 * `recordWalletBackendRequests` lists what a flow requests.
 *
 * Install right after the context launches, before onboarding. A welcome tab
 * that is already open is reloaded so it picks up the local document.
 *
 * What this route does not see fails at the launch rules
 * (`launchWalletContext`): part of OKX's telemetry POSTs to `wallet.okex.org`
 * (`apmfe/.../envelope`, `priapi/df/list`, `et/priapi/xweb`), which the route
 * misses although it matches the same URLs (why is unknown), and the
 * `wsdexpri.coinall.ltd` / `wsdexpri.okx.com` WebSockets, which routes do not
 * intercept. Neither gates a flow.
 */
export declare function installOkxOfflineRoutes(context: BrowserContext): Promise<void>;
//# sourceMappingURL=okx-offline-routes.d.ts.map