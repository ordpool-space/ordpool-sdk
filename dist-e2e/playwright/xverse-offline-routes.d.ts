import type { BrowserContext } from '@playwright/test';
/**
 * Every backend Xverse (v2.3.2) calls from its service worker and its pages:
 * the Xverse API (`api-3` mainnet, `api-testnet4`, `api-signet`, which the
 * built-in Regtest network also uses), Xverse's esplora instances (`btc-1`,
 * `btc-testnet4`, `btc-signet`), the other xverse.app hosts, Hiro's Stacks
 * API, the Spark operators (Lightspark, Breez, Flashnet), Spark's regtest
 * mempool, the sBTC mempool proxy that is the Regtest network's default
 * esplora, Mixpanel, Sparkscan, and the featured-dapp logos the home screen
 * loads from Google Cloud Storage.
 */
export declare const XVERSE_VENDOR_HOSTS: RegExp;
/**
 * Esplora's `/address/:address` summary: the captured history for a seed
 * address that has one, otherwise the server's answer for an address that
 * never saw a transaction.
 */
export declare function esploraAddressSummary(address: string): unknown;
/**
 * The answer for one request to an Xverse vendor host, or `null` for a
 * request with no captured or computed answer.
 */
export declare function xverseOfflineAnswer(url: URL): unknown | null;
/**
 * Keep Xverse's vendor backends out of the test: every request to them is
 * answered locally or aborted at once.
 *
 * The sign popup gates on Xverse's API. Its transaction summary reads
 * `GET /v2/ordinal-utxo/:txid::vout` for every input before it renders "Review
 * transaction"; a failed read renders "Transaction Error" instead, and a slow
 * one holds the popup on its spinner. The summary keeps no result for an
 * outpoint without a block height, which no regtest outpoint has, so it reads
 * the same outpoint over and over while the popup builds: 14 to 36 reads for
 * one single-input mint in local runs.
 *
 * Onboarding's restore discovery reads the seed's mainnet addresses from
 * Xverse's esplora and Hiro. Their answers decide which form the "Select a
 * wallet to restore" picker takes; a failed read shows the offline form
 * ("We couldn't retrieve account data due to network issues"). Answered from
 * the captured history, the picker is the normal one.
 *
 * Everything else (the Spark operators, Mixpanel, price and token lookups,
 * Xverse's auth endpoints) is aborted: the wallet degrades without them, and
 * an aborted request fails at once instead of waiting on a live server.
 * `recordWalletBackendRequests` lists what a flow requests.
 *
 * Aborting the Spark operators also takes their work off the CPU. With live
 * operators every open Xverse page and the service worker run Spark sessions
 * (challenge signing, node and token queries, an event stream), and the sign
 * popup shares the extension's renderer with those pages. Under a 4x CPU
 * throttle on the extension pages the popup issued its first request only
 * after 31 s and never rendered within the per-wait bound; with the Spark
 * hosts aborted it rendered in 6.5 s, and with this shield in 5.1 to 5.4 s.
 * The unshielded lane's CI traces have the same shape: each outpoint read
 * answered in about 45 ms, the reads seconds apart.
 *
 * Install right after the context launches, before onboarding or the first
 * extension page. Routes cover the service worker as well as the pages.
 */
export declare function installXverseOfflineRoutes(context: BrowserContext): Promise<void>;
//# sourceMappingURL=xverse-offline-routes.d.ts.map