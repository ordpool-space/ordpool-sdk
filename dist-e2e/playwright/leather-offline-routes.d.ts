import type { BrowserContext } from '@playwright/test';
/**
 * The mempool.space hosts Leather 6.102.0 and Cat21 Wallet (a Leather fork)
 * read: `leather.mempool.space` (Leather's mainnet esplora and price feed) and
 * `mempool.space` itself, on any network path.
 */
export declare const LEATHER_MEMPOOL_HOSTS: RegExp;
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
export declare function leatherOfflineAnswer(url: URL): unknown | null;
/**
 * Keep the Leather family's mempool.space reads out of the test: each one is
 * answered locally (`leatherOfflineAnswer`) or aborted at once.
 *
 * Install right after the context launches, before onboarding or the first
 * extension page. Routes cover the service worker as well as the pages.
 */
export declare function installLeatherOfflineRoutes(context: BrowserContext): Promise<void>;
//# sourceMappingURL=leather-offline-routes.d.ts.map