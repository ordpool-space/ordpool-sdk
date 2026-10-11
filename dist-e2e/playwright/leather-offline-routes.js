"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEATHER_MEMPOOL_HOSTS = void 0;
exports.leatherOfflineAnswer = leatherOfflineAnswer;
exports.installLeatherOfflineRoutes = installLeatherOfflineRoutes;
const testing_1 = require("ordpool-sdk/testing");
/**
 * The mempool.space hosts Leather 6.102.0 and Cat21 Wallet (a Leather fork)
 * read: `leather.mempool.space` (Leather's mainnet esplora and price feed) and
 * `mempool.space` itself, on any network path.
 */
exports.LEATHER_MEMPOOL_HOSTS = /^https:\/\/(leather\.)?mempool\.space\//;
/**
 * `GET leather.mempool.space/api/v1/prices`, captured on 2026-10-11T06:12:29Z.
 * Frozen like every captured answer: the wallet only renders it.
 */
const PRICES_CAPTURED = { time: 1791699004, USD: 82968, EUR: 74108, GBP: 62737, CAD: 118435, CHF: 68957, AUD: 119045, JPY: 13148769 };
const ADDRESS_UTXO = /^(\/(testnet4?|signet))?\/api\/address\/[a-zA-HJ-NP-Z0-9]{25,90}\/utxo$/;
const RECOMMENDED_FEES = /^(\/(testnet4?|signet))?\/api\/v1\/fees\/recommended$/;
const PRICES = /^\/api\/v1\/prices$/;
/**
 * The answer for one request to a Leather-family mempool.space host, or `null`
 * for one with no captured or computed answer.
 *
 * - `/api/address/:address/utxo`: `[]`. Leather's balance view reads the test
 *   seed's mainnet addresses; every one of the 20 the leather lane queried
 *   answered `[]` on 2026-10-11T06:12:29Z (the seed's history is all spent),
 *   which is also the server's answer for an address that never held a coin.
 * - `/api/v1/fees/recommended`: the SDK's captured sample
 *   (`recommendedFeesFixture`), so a fee display or check depends on no
 *   mainnet mempool of the day.
 * - `/api/v1/prices`: the captured body above.
 */
function leatherOfflineAnswer(url) {
    if (!exports.LEATHER_MEMPOOL_HOSTS.test(url.href))
        return null;
    const path = url.pathname;
    if (ADDRESS_UTXO.test(path))
        return [];
    if (RECOMMENDED_FEES.test(path))
        return (0, testing_1.recommendedFeesFixture)();
    if (url.host === 'leather.mempool.space' && PRICES.test(path))
        return PRICES_CAPTURED;
    return null;
}
/**
 * Keep the Leather family's mempool.space reads out of the test: each one is
 * answered locally (`leatherOfflineAnswer`) or aborted at once.
 *
 * Install right after the context launches, before onboarding or the first
 * extension page. Routes cover the service worker as well as the pages.
 */
async function installLeatherOfflineRoutes(context) {
    await context.route(exports.LEATHER_MEMPOOL_HOSTS, (route) => {
        const answer = leatherOfflineAnswer(new URL(route.request().url()));
        return answer === null
            ? route.abort('failed')
            : route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
                body: JSON.stringify(answer),
            });
    });
}
//# sourceMappingURL=leather-offline-routes.js.map