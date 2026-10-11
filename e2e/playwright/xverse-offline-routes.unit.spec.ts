import { esploraAddressSummary, installXverseOfflineRoutes, XVERSE_VENDOR_HOSTS, xverseOfflineAnswer } from './xverse-offline-routes';

// Answers captured on 2026-10-11 while Xverse 2.3.2 ran the xverse-* specs
// with the test seed on regtest (api-signet.xverse.app, btc-1.xverse.app,
// api.hiro.so), quoted as the server sent them.
const CAPTURED_ORDINAL_UTXO = '{"sat_ranges":[],"xVersion":3}';
const CAPTURED_FEES = '{"priority":2,"regular":1,"limits":{"max":5,"min":1}}';
const CAPTURED_SEED_TAPROOT = '{"address":"bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr","chain_stats":{"funded_txo_count":15,"funded_txo_sum":477744,"spent_txo_count":15,"spent_txo_sum":477744,"tx_count":30},"mempool_stats":{"funded_txo_count":0,"funded_txo_sum":0,"spent_txo_count":0,"spent_txo_sum":0,"tx_count":0}}';
const CAPTURED_UNUSED_ADDRESS = '{"address":"bc1qkljqd65ax6mdpyzm9c2r8scg8euymkfqauukae","chain_stats":{"funded_txo_count":0,"funded_txo_sum":0,"spent_txo_count":0,"spent_txo_sum":0,"tx_count":0},"mempool_stats":{"funded_txo_count":0,"funded_txo_sum":0,"spent_txo_count":0,"spent_txo_sum":0,"tx_count":0}}';
const CAPTURED_HIRO_ACCOUNT = '{"balance":"0x00000000000000000000000000000000","locked":"0x00000000000000000000000000000000","unlock_height":0,"nonce":0}';
const CAPTURED_HIRO_STX_BALANCE = '{"balance":"0","total_miner_rewards_received":"0","lock_tx_id":"","locked":"0","lock_height":0,"burnchain_lock_height":0,"burnchain_unlock_height":0}';

const OUTPOINT = 'bd4a99c813fc2c226157be9b0c842b227ad7a6f3333e7f6d5376d40f916c69ea:0';

describe('xverseOfflineAnswer', () => {
  it.each([
    'https://api-signet.xverse.app',
    'https://api-3.xverse.app',
    'https://api-testnet4.xverse.app',
  ])('answers the sign popup\'s outpoint read on %s as the indexer answers an unknown outpoint', (base) => {
    expect(xverseOfflineAnswer(new URL(`${base}/v2/ordinal-utxo/${OUTPOINT}`))).toEqual(JSON.parse(CAPTURED_ORDINAL_UTXO));
  });

  it('answers the fee estimate with the captured body', () => {
    expect(xverseOfflineAnswer(new URL('https://api-signet.xverse.app/v1/fees/btc'))).toEqual(JSON.parse(CAPTURED_FEES));
  });

  it('answers a seed address with its captured mainnet history', () => {
    expect(xverseOfflineAnswer(new URL('https://btc-1.xverse.app/address/bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr')))
      .toEqual(JSON.parse(CAPTURED_SEED_TAPROOT));
  });

  it('answers any other address as one that never saw a transaction, echoing it', () => {
    expect(xverseOfflineAnswer(new URL('https://btc-1.xverse.app/address/bc1qkljqd65ax6mdpyzm9c2r8scg8euymkfqauukae')))
      .toEqual(JSON.parse(CAPTURED_UNUSED_ADDRESS));
  });

  it.each([
    'https://btc-signet.xverse.app/address/2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2',
    'https://btc-testnet4.xverse.app/address/2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2',
    'https://beta.sbtc-mempool.tech/api/proxy/address/2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2',
  ])('answers the address summary on every Xverse esplora: %s', (url) => {
    expect(xverseOfflineAnswer(new URL(url))).toEqual(esploraAddressSummary('2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2'));
  });

  it.each([
    'https://btc-1.xverse.app/address/bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu/utxo',
    'https://btc-1.xverse.app/address/bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu/txs',
  ])('answers an address list with the empty list: %s', (url) => {
    expect(xverseOfflineAnswer(new URL(url))).toEqual([]);
  });

  it('answers Hiro\'s account and STX balance reads with the captured empty principal', () => {
    expect(xverseOfflineAnswer(new URL('https://api.hiro.so/v2/accounts/SP3XHES5990FYDV5BHBZCJRFYFD2Z4X3FMD2N3MGH?proof=0')))
      .toEqual(JSON.parse(CAPTURED_HIRO_ACCOUNT));
    expect(xverseOfflineAnswer(new URL('https://api.hiro.so/extended/v2/addresses/SP7BN6G6FKD9XSCHS6XSJ4DTW1BCQNE4TVA2WCH9/balances/stx')))
      .toEqual(JSON.parse(CAPTURED_HIRO_STX_BALANCE));
  });

  it.each([
    'https://api-signet.xverse.app/v1/auth/token',
    'https://api-signet.xverse.app/v1/prices/btc/USD',
    'https://api-3.xverse.app/v1/app-config',
    'https://btc-1.xverse.app/tx/bd4a99c813fc2c226157be9b0c842b227ad7a6f3333e7f6d5376d40f916c69ea',
    'https://api.testnet.hiro.so/extended/v1/address/STC5KHM41H6WHAST7MWWDD807YSPRQKJ68T330BQ/balances',
    'https://0.spark.lightspark.com/spark_authn.SparkAuthnService/get_challenge',
    'https://api-js.mixpanel.com/track/',
  ])('has no answer for %s', (url) => {
    expect(xverseOfflineAnswer(new URL(url))).toBeNull();
  });
});

describe('XVERSE_VENDOR_HOSTS', () => {
  it.each([
    'https://api-signet.xverse.app/v2/ordinal-utxo/x',
    'https://btc-1.xverse.app/address/x',
    'https://api.hiro.so/v2/accounts/x',
    'https://api.testnet.hiro.so/v2/accounts/x',
    'https://0.spark.lightspark.com/spark.SparkService/query_nodes',
    'https://spark-operator.breez.technology/spark.SparkService/query_nodes',
    'https://2.spark.flashnet.xyz/spark.SparkService/query_nodes',
    'https://regtest-mempool.us-west-2.sparkinfra.net/api/address/x/txs',
    'https://beta.sbtc-mempool.tech/api/proxy/address/x',
    'https://api-js.mixpanel.com/track/',
    'https://api.sparkscan.io/v1/x',
    'https://storage.googleapis.com/featured-dapps/logos/Stacking.png',
  ])('covers %s', (url) => {
    expect(XVERSE_VENDOR_HOSTS.test(url)).toBe(true);
  });

  it.each([
    'http://localhost:3010/address/bcrt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pz3cppk/utxo',
    'http://localhost:4500/',
    'https://ordpool.space/api/v1/fees/recommended',
    'https://evilxverse.app/x',
    'https://storage.googleapis.com/other-bucket/x.png',
  ])('leaves %s alone', (url) => {
    expect(XVERSE_VENDOR_HOSTS.test(url)).toBe(false);
  });
});

describe('installXverseOfflineRoutes', () => {
  type Fulfil = { status: number; contentType: string; body: string };
  function fakeRoute(url: string) {
    const calls: { fulfilled?: Fulfil; aborted?: string } = {};
    return {
      calls,
      route: {
        request: () => ({ url: () => url }),
        fulfill: async (r: Fulfil) => { calls.fulfilled = r; },
        abort: async (reason: string) => { calls.aborted = reason; },
      },
    };
  }

  async function installed() {
    const routes: { matcher: RegExp; handler: (route: unknown) => Promise<void> }[] = [];
    const context = { route: async (matcher: RegExp, handler: (route: unknown) => Promise<void>) => { routes.push({ matcher, handler }); } };
    await installXverseOfflineRoutes(context as unknown as Parameters<typeof installXverseOfflineRoutes>[0]);
    expect(routes).toHaveLength(1);
    expect(routes[0].matcher).toBe(XVERSE_VENDOR_HOSTS);
    return routes[0];
  }

  it('fulfils an answered request with the bare JSON body', async () => {
    const { handler } = await installed();
    const { route, calls } = fakeRoute(`https://api-signet.xverse.app/v2/ordinal-utxo/${OUTPOINT}`);
    await handler(route);
    expect(calls.fulfilled?.status).toBe(200);
    expect(calls.fulfilled?.contentType).toBe('application/json');
    expect(calls.fulfilled?.body).toBe(CAPTURED_ORDINAL_UTXO);
  });

  it('aborts a request with no answer instead of passing it to the server', async () => {
    const { handler } = await installed();
    const { route, calls } = fakeRoute('https://api-signet.xverse.app/v1/auth/token');
    await handler(route);
    expect(calls).toEqual({ aborted: 'failed' });
  });
});
