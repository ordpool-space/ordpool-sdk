import type { BrowserContext, Route } from '@playwright/test';

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
export const XVERSE_VENDOR_HOSTS =
  /^https:\/\/(([a-z0-9-]+\.)*(xverse\.app|hiro\.so|lightspark\.com|breez\.technology|flashnet\.xyz|sparkinfra\.net|sbtc-mempool\.tech|mixpanel\.com|sparkscan\.io)\/|storage\.googleapis\.com\/featured-dapps\/)/;

/** One side of an esplora `/address/:address` answer. */
interface EsploraStats {
  funded_txo_count: number;
  funded_txo_sum: number;
  spent_txo_count: number;
  spent_txo_sum: number;
  tx_count: number;
}

const NO_ACTIVITY: EsploraStats = { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 };

/**
 * Mainnet history of the test seed's addresses, captured from
 * `btc-1.xverse.app/address/:address` on 2026-10-11 while Xverse 2.3.2 ran
 * its restore discovery for `TEST_MNEMONIC`: confirmed `[funded_txo_count,
 * funded_txo_sum, spent_txo_count, spent_txo_sum, tx_count]`, nothing in the
 * mempool. Every other address the discovery queried had no history at all.
 *
 * The seed is a public test vector, so these addresses carry real (spent)
 * history, and with it Xverse finds accounts in both derivations: 3 in the
 * account-based wallet, 11 in the index-based one. That is what makes the
 * "Select a wallet to restore" picker appear with "See accounts" on both
 * cards, the screen `onboardXverse` walks through.
 */
const SEED_ADDRESS_HISTORY: Readonly<Record<string, readonly [number, number, number, number, number]>> = {
  'bc1qku0qh0mc00y8tk0n65x2tqw4trlspak0fnjmfz': [2, 17559, 2, 17559, 4],
  'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu': [88, 4082661, 88, 4082661, 176],
  'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr': [15, 477744, 15, 477744, 30],
  '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf': [12, 6795794, 12, 6795794, 24],
  'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g': [4, 101720, 4, 101720, 8],
  'bc1qp59yckz4ae5c4efgw2s5wfyvrz0ala7rgvuz8z': [1, 2000, 1, 2000, 2],
  '3LtMnn87fqUeHBUG414p9CWwnoV6E2pNKS': [1, 131115, 1, 131115, 2],
  '3B4cvWGR8X6Xs8nvTxVUoMJV77E4f7oaia': [1, 13199, 1, 13199, 2],
  '38CahkVftQneLonbWtfWxiiaT2fdnzsEAN': [1, 14168, 1, 14168, 2],
  'bc1qm97vqzgj934vnaq9s53ynkyf9dgr05rargr04n': [3, 14292, 3, 14292, 5],
  'bc1qgl5vlg0zdl7yvprgxj9fevsc6q6x5dmcyk3cn3': [1, 2000, 1, 2000, 2],
  'bc1qnpzzqjzet8gd5gl8l6gzhuc4s9xv0djt0rlu7a': [1, 2000, 1, 2000, 2],
  'bc1qtet8q6cd5vqm0zjfcfm8mfsydju0a29ggqrmu9': [3, 114961, 3, 114961, 6],
  'bc1qncdts3qm2guw3hjstun7dd6t3689qg4230jh2n': [4, 24440, 4, 24440, 5],
  'bc1qhxgzmkmwvrlwvlfn4qe57lx2qdfg8phycnsarn': [2, 20000, 2, 20000, 4],
  'bc1qgswpjzsqgrm2qkfkf9kzqpw6642ptrgzapvh9y': [2, 206170, 2, 206170, 4],
  'bc1qd30z5a5e50jtgx28rvt64483tq65r9pkj623wh': [1, 20000, 1, 20000, 2],
};

/**
 * Esplora's `/address/:address` summary: the captured history for a seed
 * address that has one, otherwise the server's answer for an address that
 * never saw a transaction.
 */
export function esploraAddressSummary(address: string): unknown {
  const history = SEED_ADDRESS_HISTORY[address];
  const chain = history
    ? { funded_txo_count: history[0], funded_txo_sum: history[1], spent_txo_count: history[2], spent_txo_sum: history[3], tx_count: history[4] }
    : NO_ACTIVITY;
  return { address, chain_stats: chain, mempool_stats: NO_ACTIVITY };
}

/**
 * Response bodies captured from api-signet.xverse.app on 2026-10-11, Xverse
 * 2.3.2 running the xverse-* specs with the test seed.
 */
const XVERSE_API_CAPTURED: Readonly<Record<string, unknown>> = {
  '/v1/fees/btc': { priority: 2, regular: 1, limits: { max: 5, min: 1 } },
};

/**
 * Hiro's answers for a Stacks principal that never held or sent STX, as
 * api.hiro.so returned them on 2026-10-11 for every principal the restore
 * discovery derived from the test seed.
 */
const HIRO_ACCOUNT_EMPTY = { balance: '0x00000000000000000000000000000000', locked: '0x00000000000000000000000000000000', unlock_height: 0, nonce: 0 };
const HIRO_STX_BALANCE_EMPTY = {
  balance: '0', total_miner_rewards_received: '0', lock_tx_id: '', locked: '0',
  lock_height: 0, burnchain_lock_height: 0, burnchain_unlock_height: 0,
};

const ADDRESS = '[a-zA-HJ-NP-Z0-9]{25,90}';
const ESPLORA_ADDRESS = new RegExp(`/address/(${ADDRESS})$`);
const ESPLORA_ADDRESS_LIST = new RegExp(`/address/${ADDRESS}/(utxo|txs)$`);
const STACKS_PRINCIPAL = 'S[PTM][0-9A-Z]{28,41}';
const HIRO_ACCOUNT = new RegExp(`^/v2/accounts/${STACKS_PRINCIPAL}$`);
const HIRO_STX_BALANCE = new RegExp(`^/extended/v2/addresses/${STACKS_PRINCIPAL}/balances/stx$`);

/**
 * The answer for one request to an Xverse vendor host, or `null` for a
 * request with no captured or computed answer.
 */
export function xverseOfflineAnswer(url: URL): unknown | null {
  const { host, pathname: path } = url;

  if (/^api-(3|signet|testnet4)\.xverse\.app$/.test(host)) {
    // The sign popup's transaction summary reads every input's outpoint here
    // and renders "Transaction Error" when the read fails. Regtest outpoints
    // are unknown to Xverse's indexer, which answers with no sat ranges and
    // no block height (captured on api-signet.xverse.app, 2026-10-11).
    if (/^\/v2\/ordinal-utxo\/[0-9a-f]{64}:\d+$/.test(path)) return { sat_ranges: [], xVersion: 3 };
    return path in XVERSE_API_CAPTURED ? XVERSE_API_CAPTURED[path] : null;
  }

  // Xverse's esplora instances, and the sBTC proxy under /api/proxy.
  if (/^btc-(1|testnet4|signet)\.xverse\.app$/.test(host) || host === 'beta.sbtc-mempool.tech') {
    const summary = ESPLORA_ADDRESS.exec(path);
    if (summary) return esploraAddressSummary(summary[1]);
    if (ESPLORA_ADDRESS_LIST.test(path)) return [];
    return null;
  }

  if (/^api(\.mainnet|\.testnet)?\.hiro\.so$/.test(host)) {
    if (HIRO_ACCOUNT.test(path)) return HIRO_ACCOUNT_EMPTY;
    if (HIRO_STX_BALANCE.test(path)) return HIRO_STX_BALANCE_EMPTY;
    return null;
  }

  return null;
}

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
export async function installXverseOfflineRoutes(context: BrowserContext): Promise<void> {
  await context.route(XVERSE_VENDOR_HOSTS, (route: Route) => {
    const answer = xverseOfflineAnswer(new URL(route.request().url()));
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
