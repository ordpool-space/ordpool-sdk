"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CAT21_WALLET_ORD_HOST = void 0;
exports.mainnetAddressOnRegtest = mainnetAddressOnRegtest;
exports.cat21OrdRegtestUrl = cat21OrdRegtestUrl;
exports.hasCat21WalletOrdRoutes = hasCat21WalletOrdRoutes;
exports.installCat21WalletOrdRoutes = installCat21WalletOrdRoutes;
exports.wasCancelledByItsPage = wasCancelledByItsPage;
exports.closeCat21WalletPage = closeCat21WalletPage;
const btc_signer_1 = require("@scure/btc-signer");
const network_1 = require("ordpool-sdk/network");
const regtest_helpers_1 = require("../regtest/regtest-helpers");
/**
 * The cat21-ord instance Cat21 Wallet reads: `https://ord.cat21.space`, a
 * constant in the wallet (`CAT21_ORD_DEFAULT_BASE_URL`,
 * `packages/services/src/infrastructure/api/cat21-ord/cat21-ord-api.utils.ts`).
 * The wallet has no setting that moves it.
 */
exports.CAT21_WALLET_ORD_HOST = /^https:\/\/ord\.cat21\.space\//;
const REGTEST = (0, network_1.toScureNetwork)(network_1.Network.Regtest);
/**
 * A mainnet address as the regtest address of the same output script, or
 * `null` for anything that is not a mainnet address.
 */
function mainnetAddressOnRegtest(segment) {
    try {
        return (0, btc_signer_1.Address)(REGTEST).encode((0, btc_signer_1.Address)(btc_signer_1.NETWORK).decode(segment));
    }
    catch {
        return null;
    }
}
/**
 * The regtest cat21-ord URL that answers one of the wallet's requests to
 * `ord.cat21.space`: same path and query on `ordUrl`, with every mainnet
 * address in the path replaced by its regtest twin.
 *
 * The wallet runs on mainnet, so it asks for its mainnet addresses (the
 * dashboard's `GET /address/<address>` per account). The specs fund and mint
 * at the regtest addresses of the same keys, and a regtest ord refuses a
 * mainnet address (`require_network`), so the address is translated and the
 * answer is the regtest chain's own: the outputs, inscriptions and cat numbers
 * the specs created there. `/address` answers carry no address string, so the
 * body needs no translation back.
 */
function cat21OrdRegtestUrl(url, ordUrl) {
    const path = url.pathname
        .split('/')
        .map((segment) => mainnetAddressOnRegtest(decodeURIComponent(segment)) ?? segment)
        .join('/');
    return `${ordUrl.replace(/\/$/, '')}${path}${url.search}`;
}
/**
 * The contexts `installCat21WalletOrdRoutes` forwards reads for. Their
 * extension pages are Cat21 Wallet pages, which close through
 * `closeCat21WalletPage` so no forwarded read is left paused.
 */
const contextsWithCat21WalletOrdRoutes = new WeakSet();
/**
 * True when `installCat21WalletOrdRoutes` runs on `context`, which makes every
 * extension page in it a Cat21 Wallet page.
 */
function hasCat21WalletOrdRoutes(context) {
    return contextsWithCat21WalletOrdRoutes.has(context);
}
/**
 * Answer Cat21 Wallet's cat21-ord reads from the regtest cat21-ord the stack
 * runs, instead of our production `ord.cat21.space`.
 *
 * Each request is forwarded to `ordUrl` (default: the regtest helpers'
 * `ORD_URL`: `REGTEST_ORD_URL`, else the slot's `E2E_ORD_HOST_PORT`) with its mainnet addresses
 * translated (`cat21OrdRegtestUrl`), and the regtest ord's response is
 * returned to the wallet as it came. A cat21-ord that is not running fails the
 * request rather than falling back to production.
 *
 * Install right after the context launches, before onboarding: the dashboard
 * reads `/address` for every account as soon as the wallet is unlocked.
 */
async function installCat21WalletOrdRoutes(context, opts = {}) {
    const ordUrl = opts.ordUrl ?? regtest_helpers_1.ORD_URL;
    contextsWithCat21WalletOrdRoutes.add(context);
    await context.route(exports.CAT21_WALLET_ORD_HOST, async (route) => {
        const request = route.request();
        let response;
        try {
            response = await route.fetch({ url: cat21OrdRegtestUrl(new URL(request.url()), ordUrl) });
        }
        catch (e) {
            if (wasCancelledByItsPage(request))
                return;
            throw e;
        }
        await route.fulfill({
            response,
            headers: { ...response.headers(), 'access-control-allow-origin': '*' },
        });
    });
}
/**
 * Whether the browser cancelled `request` because its page navigated away or
 * closed (`net::ERR_ABORTED`): its page no longer waits for an answer, so there
 * is none to forward, and `route.fetch` rejects for it. Any other failure,
 * such as the regtest cat21-ord refusing the connection, is not this.
 */
function wasCancelledByItsPage(request) {
    return request.failure()?.errorText === 'net::ERR_ABORTED';
}
/**
 * Close a Cat21 Wallet page without sending its pending cat21-ord reads to the
 * network.
 *
 * A page closed while `installCat21WalletOrdRoutes` forwards one of its reads
 * leaves that read paused in the browser; when the page's DevTools session
 * goes away the browser lets it continue to `ord.cat21.space`, where the
 * offline launch blocks it, and it shows in the net log as blocked. Navigating
 * the page away first makes the browser cancel those reads (`net::ERR_ABORTED`)
 * before anything is sent, and only then is the page closed.
 */
async function closeCat21WalletPage(page) {
    await page.goto('about:blank');
    await page.close();
}
//# sourceMappingURL=cat21wallet-ord-routes.js.map