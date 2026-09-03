import { BrowserContext, Route } from '@playwright/test';

/**
 * Wizz is a mainnet-only, unisat-derived wallet. Its dashboard and its
 * sign-approval popup load the account's balance + assets from several
 * external services before enabling the Sign button. CI has NO outbound
 * internet, so those fetches fail, the sign popup renders "Failed to
 * load balance", and Sign stays disabled forever, so a roundtrip spec
 * times out waiting for the button to become clickable.
 *
 * Fulfil each external balance/asset source with its real ZERO-balance
 * response shape (captured from the live APIs) so Wizz loads an empty
 * account and enables Sign. Signing a PSBT needs no funds; the regtest
 * funding + broadcast run through the SDK harness + local electrs
 * (localhost:3000), which every route below passes through untouched.
 *
 * The BTC balance itself comes from unisat's `v5/address/multi-assets`
 * (`btcSatoshis`), so that one is the load-bearing mock; the electrum
 * proxy (atomicals), rgbpp (RGB++ assets) and market endpoints are
 * secondary and get benign empty successes so none of them reject.
 */
export async function installWizzOfflineRoutes(context: BrowserContext): Promise<void> {
  const json = (route: Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  // configs.wizz.cash has no valid offline payload; Wizz mounts without it.
  await context.route('**/configs.wizz.cash/**', route => route.abort());

  // unisat wallet-api (v5) — the account balance + asset counts. The
  // envelope is { code, msg, data }; shapes captured from the live API.
  await context.route('**/wallet-api.unisat.io/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/address/multi-assets')) {
      return json(route, { code: 0, msg: 'ok', data: [{
        totalSatoshis: 0, btcSatoshis: 0, assetSatoshis: 0,
        inscriptionCount: 0, atomicalsCount: 0,
        brc20Count: 0, brc20Count5Byte: 0, brc20Count6Byte: 0,
        arc20Count: 0, runesCount: 0,
      }] });
    }
    if (/\/(inscriptions|list)\b/.test(path) || /brc20/.test(path)) {
      return json(route, { code: 0, msg: 'ok', data: { list: [], total: 0 } });
    }
    return json(route, { code: 0, msg: 'ok', data: null });
  });

  // Wizz's atomicals electrum-over-HTTP proxy + runes/market endpoints:
  // empty success so no asset lookup rejects.
  await context.route(/https:\/\/(ep|ordx|mkt)\.wizz\.cash\//, route => json(route, {}));

  // RGB++ assets (needs a bearer token Wizz mints online; offline it
  // 401s). Return an empty asset set so the RGB++ lane resolves quietly.
  await context.route(/https:\/\/api[a-z.]*\.rgbpp\.io\//, route => json(route, {}));

  // Esplora (mempool.space + Tor mirror): address summary/history and
  // recommended fees. Only external hosts; localhost electrs passes
  // through. Fees are a regtest test fixture, not a displayed value.
  await context.route('**/api/v1/fees/recommended*', route =>
    json(route, { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 }));

  const ESPLORA_ZERO = {
    funded_txo_count: 0, funded_txo_sum: 0,
    spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0,
  };
  await context.route('**/api/address/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return route.continue();
    }
    const path = url.pathname;
    if (/\/(txs|utxo)(\/|$)/.test(path)) {
      return json(route, []);
    }
    const addr = decodeURIComponent(path.split('/api/address/')[1]?.split('/')[0] ?? '');
    return json(route, { address: addr, chain_stats: ESPLORA_ZERO, mempool_stats: ESPLORA_ZERO });
  });
}
