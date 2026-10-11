/**
 * @test-kind unit
 * Real:   mainnetAddressOnRegtest, cat21OrdRegtestUrl, installCat21WalletOrdRoutes, @scure/btc-signer
 * Faked:  the BrowserContext (route) and the route (request/fetch/fulfill), shapes: @playwright/test types
 * Proves: Cat21 Wallet's ord.cat21.space reads go to the regtest cat21-ord, with its mainnet addresses as their regtest twins
 */
import { CAT21_WALLET_ORD_HOST, cat21OrdRegtestUrl, installCat21WalletOrdRoutes, mainnetAddressOnRegtest } from './cat21wallet-ord-routes';

// The test seed's BIP-84 payment and BIP-86 ordinals addresses (account 0),
// with their regtest encodings computed outside @scure (a plain bech32 /
// bech32m re-encode of the same witness program under the `bcrt` prefix).
const PAYMENT = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const PAYMENT_REGTEST = 'bcrt1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx';
const ORDINALS = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const ORDINALS_REGTEST = 'bcrt1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqvg32hk';

describe('mainnetAddressOnRegtest', () => {
  it('re-encodes a P2WPKH and a P2TR mainnet address for regtest', () => {
    expect(mainnetAddressOnRegtest(PAYMENT)).toBe(PAYMENT_REGTEST);
    expect(mainnetAddressOnRegtest(ORDINALS)).toBe(ORDINALS_REGTEST);
  });

  it.each(['address', 'status', '0', PAYMENT_REGTEST, 'tb1qcr8te4kr609gcawutmrza0j4xv80jy8zmfp6l0'])(
    'has no regtest twin for %s',
    (segment) => {
      expect(mainnetAddressOnRegtest(segment)).toBeNull();
    },
  );
});

describe('cat21OrdRegtestUrl', () => {
  it('moves an /address read to the regtest ord, with the address translated', () => {
    expect(cat21OrdRegtestUrl(new URL(`https://ord.cat21.space/address/${ORDINALS}`), 'http://localhost:28080'))
      .toBe(`http://localhost:28080/address/${ORDINALS_REGTEST}`);
  });

  it('keeps paths without an address and the query string as they are', () => {
    expect(cat21OrdRegtestUrl(new URL('https://ord.cat21.space/status'), 'http://localhost:8080/'))
      .toBe('http://localhost:8080/status');
    expect(cat21OrdRegtestUrl(new URL('https://ord.cat21.space/output/ab%3A0?x=1'), 'http://localhost:8080'))
      .toBe('http://localhost:8080/output/ab%3A0?x=1');
  });
});

describe('CAT21_WALLET_ORD_HOST', () => {
  it.each([
    [`https://ord.cat21.space/address/${PAYMENT}`, true],
    ['https://ord.ordpool.space/output/ab:0', false],
    ['https://backend2.cat21.space/api/cats', false],
    ['http://localhost:8080/status', false],
  ])('matches %s: %s', (url, matches) => {
    expect(CAT21_WALLET_ORD_HOST.test(url)).toBe(matches);
  });
});

describe('installCat21WalletOrdRoutes', () => {
  type Handler = (route: unknown) => Promise<void>;

  it('fetches the regtest twin of the request and fulfils the wallet with that answer', async () => {
    const routes: { pattern: RegExp; handler: Handler }[] = [];
    await installCat21WalletOrdRoutes(
      { route: async (pattern: RegExp, handler: Handler) => { routes.push({ pattern, handler }); } } as never,
      { ordUrl: 'http://localhost:28080' },
    );
    expect(routes).toHaveLength(1);
    const url = `https://ord.cat21.space/address/${PAYMENT}`;
    expect(routes[0].pattern.test(url)).toBe(true);

    const regtestAnswer = { headers: () => ({ 'content-type': 'application/json' }) };
    const calls: { fetched?: string; fulfilled?: { response: unknown; headers: Record<string, string> } } = {};
    await routes[0].handler({
      request: () => ({ url: () => url }),
      fetch: async (o: { url: string }) => { calls.fetched = o.url; return regtestAnswer; },
      fulfill: async (o: { response: unknown; headers: Record<string, string> }) => { calls.fulfilled = o; },
    });
    expect(calls.fetched).toBe(`http://localhost:28080/address/${PAYMENT_REGTEST}`);
    expect(calls.fulfilled?.response).toBe(regtestAnswer);
    expect(calls.fulfilled?.headers).toEqual({ 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  });
});
