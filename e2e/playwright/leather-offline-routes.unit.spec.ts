/**
 * @test-kind unit
 * Real:   leatherOfflineAnswer, LEATHER_VENDOR_HOSTS, installLeatherOfflineRoutes, recommendedFeesFixture (ordpool-sdk/testing)
 * Faked:  the BrowserContext (route) and the route (request/fulfill/abort), shapes: @playwright/test types
 * Proves: every mempool.space read of the Leather family is answered from a captured answer or aborted, and every
 *         request to its other vendor backends is aborted, never sent
 */
import { recommendedFeesFixture } from 'ordpool-sdk/testing';
import { installLeatherOfflineRoutes, LEATHER_MEMPOOL_HOSTS, LEATHER_VENDOR_HOSTS, leatherOfflineAnswer } from './leather-offline-routes';

const SEED_ADDRESS = 'bc1qku0qh0mc00y8tk0n65x2tqw4trlspak0fnjmfz';

describe('leatherOfflineAnswer', () => {
  it('answers an address UTXO read with the empty list, on mainnet and the test networks', () => {
    expect(leatherOfflineAnswer(new URL(`https://leather.mempool.space/api/address/${SEED_ADDRESS}/utxo`))).toEqual([]);
    expect(leatherOfflineAnswer(new URL('https://leather.mempool.space/testnet4/api/address/tb1qku0qh0mc00y8tk0n65x2tqw4trlspak0q0q0q0/utxo'))).toEqual([]);
  });

  it.each([
    'https://mempool.space/api/v1/fees/recommended',
    'https://leather.mempool.space/api/v1/fees/recommended',
    'https://leather.mempool.space/testnet/api/v1/fees/recommended',
  ])('answers %s with the captured fee sample', (url) => {
    expect(leatherOfflineAnswer(new URL(url))).toEqual({ fastestFee: 2, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 });
    expect(leatherOfflineAnswer(new URL(url))).toEqual(recommendedFeesFixture());
  });

  it('answers the price feed with the capture of 2026-10-11', () => {
    expect(leatherOfflineAnswer(new URL('https://leather.mempool.space/api/v1/prices'))).toEqual({
      time: 1791699004, USD: 82968, EUR: 74108, GBP: 62737, CAD: 118435, CHF: 68957, AUD: 119045, JPY: 13148769,
    });
  });

  it.each([
    `https://leather.mempool.space/api/address/${SEED_ADDRESS}/txs`,
    'https://leather.mempool.space/api/blocks/tip/height',
    'https://mempool.space/api/v1/prices',
  ])('has no answer for %s', (url) => {
    expect(leatherOfflineAnswer(new URL(url))).toBeNull();
  });

  it.each([
    'https://api.leather.io/v1/market/prices/native',
    'http://localhost:3010/api/address/bcrt1q/utxo',
    'https://evil.example/https://mempool.space/api/v1/fees/recommended',
  ])('leaves %s to its own route', (url) => {
    expect(LEATHER_MEMPOOL_HOSTS.test(url)).toBe(false);
    expect(leatherOfflineAnswer(new URL(url))).toBeNull();
  });
});

describe('installLeatherOfflineRoutes', () => {
  type Handler = (route: unknown) => Promise<void>;

  async function routeOnce(url: string) {
    const routes: { pattern: RegExp; handler: Handler }[] = [];
    await installLeatherOfflineRoutes({ route: async (pattern: RegExp, handler: Handler) => { routes.push({ pattern, handler }); } } as never);
    expect(routes.map((r) => r.pattern)).toEqual([LEATHER_VENDOR_HOSTS, LEATHER_MEMPOOL_HOSTS]);
    const matching = routes.filter((r) => r.pattern.test(url));
    expect(matching).toHaveLength(1);
    const outcome: { fulfilled?: { status: number; body: string }; aborted?: string } = {};
    await matching[0].handler({
      request: () => ({ url: () => url }),
      fulfill: async (r: { status: number; body: string }) => { outcome.fulfilled = r; },
      abort: async (code: string) => { outcome.aborted = code; },
    });
    return outcome;
  }

  it('fulfils a read it has an answer for', async () => {
    const outcome = await routeOnce('https://mempool.space/api/v1/fees/recommended');
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.fulfilled?.status).toBe(200);
    expect(JSON.parse(outcome.fulfilled?.body ?? 'null')).toEqual(recommendedFeesFixture());
  });

  it('aborts a read it has no answer for, so nothing reaches the live host', async () => {
    const outcome = await routeOnce('https://leather.mempool.space/api/blocks/tip/height');
    expect(outcome).toEqual({ aborted: 'failed' });
  });

  it.each([
    'https://api.leather.io/v1/market/prices/native',
    'https://staging.api.leather.io/v1/utxos/wpkh(xpub6CatWdiZ)',
    'https://api.hiro.so/extended/v2/addresses/SP17M98YMR68S393P2P8AK3CWEJY9HQ6WGRPEBHRJ/balances/stx',
    'https://api.bnsv2.com/names/address/SP3XHES5990FYDV5BHBZCJRFYFD2Z4X3FMD2N3MGH/valid',
    'https://app.launchdarkly.com/sdk/goals/67ab2e1889ad710a6804a10a',
    'https://clientstream.launchdarkly.com/eval/67ab2e1889ad710a6804a10a/x',
    'https://api-js.mixpanel.com/track/',
    'https://o4504203991318528.ingest.us.sentry.io/api/4504204000952320/envelope/',
    'https://api.coingecko.com/api/v3/simple/price',
    'https://api1.binance.com/api/v3/ticker/price',
    'https://leatherapi.bestinslot.xyz/v3/wallet/inscriptions_xpub',
    'https://stampchain.io/api/v2/balance/bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    'https://gamma.io/api/get-stacks-nft',
    'https://api.bitflowapis.finance/getAllTokensAndPools',
    'https://api.chainalysis.com/api/risk/v2/entities',
    'https://70cnou7r.apicdn.sanity.io/v2024-01-01/data/query/production',
    'https://avatar.vercel.sh/03',
    'https://www.google.com/s2/favicons?domain=localhost',
    'https://raw.githubusercontent.com/leather-io/extension/main/config/wallet-config.json',
  ])('aborts the vendor request %s', async (url) => {
    expect(await routeOnce(url)).toEqual({ aborted: 'failed' });
  });

  it.each([
    'http://localhost:4500/',
    'https://ord.cat21.space/address/bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    'https://raw.githubusercontent.com/unisat-wallet/phishing-detect/master/phishing_sites.json',
    'https://www.google.com/search?q=leather.io',
    'https://evil.example/https://api.hiro.so/',
  ])('leaves %s alone', (url) => {
    expect(LEATHER_VENDOR_HOSTS.test(url)).toBe(false);
    expect(LEATHER_MEMPOOL_HOSTS.test(url)).toBe(false);
  });
});
