/**
 * @test-kind unit
 * Real:   installWizzOfflineRoutes, decodeUnisatPsbt, recommendedFeesFixture (ordpool-sdk/testing)
 * Faked:  the BrowserContext (route) and the route (request/fulfill/abort), shapes: @playwright/test types
 * Proves: Wizz's fee lookup on mempool.space is answered with the SDK's captured sample, and only that URL;
 *         its decode2 PSBT analysis is answered from the PSBT as UniSat's server answered it on the wizz lane;
 *         its RGB++ token requests for the test networks are aborted
 */
import { recommendedFeesFixture } from 'ordpool-sdk/testing';
import { installWizzOfflineRoutes, WIZZ_RECOMMENDED_FEES_URL, WIZZ_RGBPP_TEST_NETWORKS } from './wizz-offline-routes';

// A fake BrowserContext recording `route()` registrations. The shield's IO
// boundary is exactly `context.route` and `route.fulfill`.

interface Fulfilled { status: number; contentType: string; headers: Record<string, string>; body: string }
type Handler = (route: {
  fulfill: (r: Fulfilled) => Promise<void>;
  abort?: (code: string) => Promise<void>;
  request: () => unknown;
}) => Promise<void>;

function fakeContext() {
  const routes: { pattern: string | RegExp; handler: Handler }[] = [];
  const context = {
    route: async (pattern: string | RegExp, handler: Handler) => { routes.push({ pattern, handler }); },
  };
  return { context: context as unknown as Parameters<typeof installWizzOfflineRoutes>[0], routes };
}

const FEES_URL = 'https://mempool.space/api/v1/fees/recommended';

describe('installWizzOfflineRoutes: the fee estimate', () => {
  it('answers mempool.space/api/v1/fees/recommended with the captured fixture', async () => {
    const { context, routes } = fakeContext();
    await installWizzOfflineRoutes(context);

    const matching = routes.filter((r) => r.pattern instanceof RegExp && r.pattern.test(FEES_URL));
    expect(matching).toHaveLength(1);
    const fulfilled: Fulfilled[] = [];
    await matching[0].handler({ fulfill: async (r) => { fulfilled.push(r); }, request: () => ({ url: () => FEES_URL }) });
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].status).toBe(200);
    expect(fulfilled[0].contentType).toBe('application/json');
    // The captured sample, by value: a quiet mempool's 2/1/1/1/1.
    expect(JSON.parse(fulfilled[0].body)).toEqual({ fastestFee: 2, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 });
    // And by source: the shield serves the SDK's one fixture, not a copy of it.
    expect(JSON.parse(fulfilled[0].body)).toEqual(recommendedFeesFixture());
  });

  it.each([
    FEES_URL,
    `${FEES_URL}?_=1760000000`,
  ])('matches %s', (url) => {
    expect(WIZZ_RECOMMENDED_FEES_URL.test(url)).toBe(true);
  });

  it.each([
    'https://mempool.space/api/v1/fees/mempool-blocks',
    'https://mempool.space/testnet/api/v1/fees/recommended',
    'http://localhost:8999/api/v1/fees/recommended',
    'https://evil.example/https://mempool.space/api/v1/fees/recommended',
  ])('leaves %s alone', (url) => {
    expect(WIZZ_RECOMMENDED_FEES_URL.test(url)).toBe(false);
  });
});

// `POST wallet-api.unisat.io/v5/tx/decode2` as Wizz 2.13.4 sent it on the wizz
// lane's mint (wizz-mint-roundtrip, 2026-10-11T08:06:07Z), and the `data` of
// UniSat's answer to it.
const MINT_PSBT_HEX = '70736274ff01007d0200000001df65673d31763dc31aba9663372aff3f4fa8ca9fa53e17aa5e2fd35a2c1429180100000000feffffff0222020000000000002251203da777e669657c8d8789d6a8a389b592ec8902b0651d4fa900722c7c9b8a24e7a27e010000000000160014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e2150000000001011fa086010000000000160014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e201030401000000000000';
const MINT_SERVER_ANSWER = {"inputInfos":[{"txid":"1829142c5ad32f5eaa173ea59fcaa84f3fff2a376396ba1ac33d76313d6765df","vout":1,"address":"bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu","value":100000,"inscriptions":[],"atomicals":[],"alkanes":[],"runes":[],"sighashType":1,"onchain":false,"utxoStatus":{"utxoFound":false,"atomicalsChecked":false,"isConfirmed":false,"inscriptionDoubleChecked":false,"runesChecked":false,"indexerChecked":false,"unlocked":false},"brc20Count":0}],"outputInfos":[{"address":"bc1p8knh0enfv47gmpuf66528zd4jtkgjq4sv5w5l2gqwgk8exu2ynns9g8c9m","value":546,"inscriptions":[],"atomicals":[],"runes":[],"alkanes":[],"isOpReturn":false},{"address":"bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu","value":97954,"inscriptions":[],"atomicals":[],"runes":[],"alkanes":[],"isOpReturn":false}],"feeRate":"≈9.9","fee":1500,"isCompleted":true,"risks":[],"features":{"rbf":false},"inscriptions":{},"recommendedFeeRate":1,"shouldWarnFeeRate":true};

describe('installWizzOfflineRoutes: the PSBT analysis', () => {
  const DECODE2_URL = 'https://wallet-api.unisat.io/v5/tx/decode2?_=1';

  async function decode2(postData: string) {
    const { context, routes } = fakeContext();
    await installWizzOfflineRoutes(context);
    const unisat = routes.filter((r) => r.pattern === '**/wallet-api.unisat.io/**');
    expect(unisat).toHaveLength(1);
    const outcome: { fulfilled?: Fulfilled; aborted?: string } = {};
    await unisat[0].handler({
      fulfill: async (r) => { outcome.fulfilled = r; },
      abort: async (code) => { outcome.aborted = code; },
      request: () => ({ url: () => DECODE2_URL, postData: () => postData }),
    });
    return outcome;
  }

  it('answers decode2 from the PSBT, as UniSat answered the same PSBT except the display-only fee fields', async () => {
    const outcome = await decode2(JSON.stringify({ psbtHex: MINT_PSBT_HEX, website: 'http://localhost:4500' }));
    expect(outcome.aborted).toBeUndefined();
    const body = JSON.parse(outcome.fulfilled?.body ?? 'null') as { code: number; msg: string; data: Record<string, unknown> };
    expect(body.code).toBe(0);
    expect(body.msg).toBe('ok');
    const { feeRate: _f, shouldWarnFeeRate: _w, ...server } = MINT_SERVER_ANSWER;
    const { feeRate: _of, shouldWarnFeeRate: _ow, ...ours } = body.data;
    expect(ours).toEqual(server);
  });

  it('aborts a decode2 request that carries no PSBT', async () => {
    expect(await decode2('{}')).toEqual({ aborted: 'failed' });
  });
});

describe('installWizzOfflineRoutes: the RGB++ test networks', () => {
  it.each([
    'https://api.testnet.rgbpp.io/token/generate',
    'https://api.signet.rgbpp.io/token/generate',
  ])('aborts %s', async (url) => {
    const { context, routes } = fakeContext();
    await installWizzOfflineRoutes(context);
    const matching = routes.filter((r) => r.pattern === WIZZ_RGBPP_TEST_NETWORKS);
    expect(matching).toHaveLength(1);
    expect(WIZZ_RGBPP_TEST_NETWORKS.test(url)).toBe(true);
    const outcome: { aborted?: string } = {};
    await matching[0].handler({
      fulfill: async () => { throw new Error('fulfilled'); },
      abort: async (code) => { outcome.aborted = code; },
      request: () => ({ url: () => url }),
    });
    expect(outcome).toEqual({ aborted: 'failed' });
  });

  it.each([
    'https://api.rgbpp.io/token/generate',
    'http://localhost:4500/',
  ])('leaves %s to its own route', (url) => {
    expect(WIZZ_RGBPP_TEST_NETWORKS.test(url)).toBe(false);
  });
});
