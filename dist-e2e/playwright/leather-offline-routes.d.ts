import type { BrowserContext } from '@playwright/test';
/**
 * The mempool.space hosts Leather 6.102.0 and Cat21 Wallet (a Leather fork)
 * read: `leather.mempool.space` (Leather's mainnet esplora and price feed) and
 * `mempool.space` itself, on any network path.
 */
export declare const LEATHER_MEMPOOL_HOSTS: RegExp;
/**
 * Every other vendor backend Leather 6.102.0 and Cat21 Wallet call, from the
 * service worker and the pages, as recorded on the leather and cat21wallet
 * lanes: Leather's own API (`api.leather.io`, `staging.api.leather.io`) and
 * remote config (`raw.githubusercontent.com/leather-io/`), Hiro's Stacks API
 * and BNS (`api.hiro.so`, `api.bnsv2.com`), the asset indexers (Best in Slot,
 * Stampchain, Gamma, Bitflow), the price feeds (CoinGecko, Binance), the
 * Chainalysis address screen, Sanity (announcements), LaunchDarkly (feature
 * flags), Mixpanel and Sentry, and the avatar and favicon images
 * (`avatar.vercel.sh`, `www.google.com/s2/favicons`).
 */
export declare const LEATHER_VENDOR_HOSTS: RegExp;
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
 * Keep the Leather family's vendor backends out of the test: a mempool.space
 * read is answered locally (`leatherOfflineAnswer`) or aborted, and every
 * request to another vendor host (`LEATHER_VENDOR_HOSTS`) is aborted at once.
 *
 * None of the aborted hosts gates a flow the specs drive: the leather and
 * cat21wallet lanes pass with every host except localhost unreachable. The
 * wallets degrade without them (no Stacks balance, no BNS name, no fiat value,
 * default feature flags, no announcements, no avatars). An aborted request
 * fails at once instead of waiting on a live server, and a new dependency is
 * listed by `recordWalletBackendRequests` rather than reaching a vendor.
 *
 * Install right after the context launches, before onboarding or the first
 * extension page. Routes cover the service worker as well as the pages.
 *
 * What this route does not see fails at the launch rules
 * (`launchWalletContext`): Leather's Sentry and Mixpanel POSTs, which the
 * route misses although it matches the same URLs (why is unknown), and the
 * mempool.space live-update WebSocket (`wss://leather.mempool.space/api/v1/ws`),
 * which `context.routeWebSocket` does not intercept. Neither gates a flow.
 */
export declare function installLeatherOfflineRoutes(context: BrowserContext): Promise<void>;
//# sourceMappingURL=leather-offline-routes.d.ts.map