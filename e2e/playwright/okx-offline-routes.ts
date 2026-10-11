import type { BrowserContext, Route } from '@playwright/test';

/**
 * The vendor web page OKX Wallet (v4.1.0) opens in a normal browser tab during
 * onboarding, right after the import-wallet click.
 */
export const OKX_WELCOME_PAGE_URL = 'https://web3.okx.com/extension';

/** Stand-in document for the welcome tab: no scripts, no subresources. */
const OFFLINE_WELCOME_HTML = '<!doctype html><meta charset="utf-8"><title>OKX welcome page (offline)</title>';

const isWelcomePage = (url: URL): boolean =>
  url.origin === 'https://web3.okx.com' && url.pathname === '/extension';

/**
 * Every backend OKX Wallet (v4.1.0) calls from its service worker and its
 * pages, as recorded on the okx lane: its wallet API on `wallet.okx.com` and
 * the mirror `wallet.okex.org` (`priapi/*`, `v1/deposit/plugin/*`, the
 * `et/priapi/xweb` telemetry, the `apmfe` error reports), the CDNs
 * `static.okx.com` and `static.coinall.ltd` (translations, remote config,
 * logos), the heartbeat failover hosts (`web3.okx.com`, `wallet.ouxyi.cash`,
 * `web3.ouchyi.bid`, `web3.chouyi.pink`) and its DNS-over-HTTPS lookups
 * (`www.okx-httpdns.com`, `www.okx-doh.com`, and the two IP addresses the
 * bundle hardcodes, `47.57.9.204` and `47.75.96.239`, which no DNS rule can
 * keep in).
 */
export const OKX_VENDOR_HOSTS =
  /^https:\/\/(([a-z0-9-]+\.)*(okx\.com|okex\.org|coinall\.ltd|okx-httpdns\.com|okx-doh\.com|ouxyi\.cash|ouchyi\.bid|chouyi\.pink)|47\.57\.9\.204|47\.75\.96\.239)\//;

const isVendorRequest = (url: URL): boolean => OKX_VENDOR_HOSTS.test(url.href);

const isWalletApi = (url: URL): boolean => url.host === 'wallet.okx.com' || url.host === 'wallet.okex.org';

/** The sign popup's pre-execution check, on either API host. */
const isPreExec = (url: URL): boolean => isWalletApi(url) && url.pathname === '/priapi/v2/wallet/tx/preExecTransactionv2';

/**
 * `POST /priapi/v2/wallet/tx/preExecTransactionv2` for a `signPsbt` request,
 * as the server answered every one the okx-* specs sent on 2026-10-11: no
 * popup notices, no simulated transaction.
 */
export const OKX_PRE_EXEC_ANSWER = { popupInfoList: [], txInfo: null };

/** OKX's API envelope around a successful answer. */
function okxOk(data: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
    body: JSON.stringify({ code: 0, msg: '', error_code: '0', error_message: '', detailMsg: '', data }),
  };
}

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
 * Not covered, seen in Chrome's net log on the okx lane with the network up:
 * part of OKX's telemetry POSTs to `wallet.okex.org` (`apmfe/.../envelope`,
 * `priapi/df/list`, `et/priapi/xweb`), which reach the host although this
 * route aborts the same URLs (why the route does not see them is unknown), and
 * the `wsdexpri.coinall.ltd` / `wsdexpri.okx.com` WebSockets, which routes do
 * not intercept. Neither gates a flow: the lane passes with them unreachable.
 */
export async function installOkxOfflineRoutes(context: BrowserContext): Promise<void> {
  await context.route(isVendorRequest, (route: Route) => route.abort('failed'));
  await context.route(isPreExec, (route: Route) => route.fulfill(okxOk(OKX_PRE_EXEC_ANSWER)));
  await context.route(isWelcomePage, (route: Route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    headers: { 'cache-control': 'no-store' },
    body: OFFLINE_WELCOME_HTML,
  }));
  for (const page of context.pages()) {
    if (isWelcomePage(new URL(page.url()))) {
      await page.goto(OKX_WELCOME_PAGE_URL, { waitUntil: 'domcontentloaded' });
    }
  }
}
