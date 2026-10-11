/**
 * @test-kind unit
 * Real:   mainnetAddressOnRegtest, cat21OrdRegtestUrl, installCat21WalletOrdRoutes, wasCancelledByItsPage,
 *         closeCat21WalletPage, @scure/btc-signer
 * Faked:  the BrowserContext (route), the route (request/fetch/fulfill) and the page (goto/close), shapes:
 *         @playwright/test types; the ERR_ABORTED failure is the one Chromium reports for a read whose page
 *         navigated away (observed with Cat21 Wallet 1178faf, 2026-10-11)
 * Proves: Cat21 Wallet's ord.cat21.space reads go to the regtest cat21-ord, with its mainnet addresses as their regtest
 *         twins; a read its page cancelled ends quietly and any other forwarding failure fails loudly; a wallet page
 *         is navigated away before it closes
 */
import {
  CAT21_WALLET_ORD_HOST,
  cat21OrdRegtestUrl,
  closeCat21WalletPage,
  installCat21WalletOrdRoutes,
  mainnetAddressOnRegtest,
  wasCancelledByItsPage,
} from './cat21wallet-ord-routes';

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

describe('a read its page cancelled', () => {
  type Handler = (route: unknown) => Promise<void>;

  async function handler(): Promise<Handler> {
    const routes: Handler[] = [];
    await installCat21WalletOrdRoutes(
      { route: async (_pattern: RegExp, h: Handler) => { routes.push(h); } } as never,
      { ordUrl: 'http://localhost:28080' },
    );
    return routes[0];
  }

  /** A route whose forward rejects, for a request that failed with `errorText` (or did not fail). */
  function failingRoute(errorText: string | null) {
    const calls = { fulfilled: 0 };
    return {
      calls,
      route: {
        request: () => ({
          url: () => `https://ord.cat21.space/address/${PAYMENT}`,
          failure: () => (errorText === null ? null : { errorText }),
        }),
        fetch: async () => { throw new Error('route.fetch: Target page, context or browser has been closed'); },
        fulfill: async () => { calls.fulfilled += 1; },
      },
    };
  }

  it('wasCancelledByItsPage is ERR_ABORTED and nothing else', () => {
    expect(wasCancelledByItsPage({ failure: () => ({ errorText: 'net::ERR_ABORTED' }) })).toBe(true);
    expect(wasCancelledByItsPage({ failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }) })).toBe(false);
    expect(wasCancelledByItsPage({ failure: () => null })).toBe(false);
  });

  it('ends without an answer when the page cancelled it', async () => {
    const r = failingRoute('net::ERR_ABORTED');
    await (await handler())(r.route);
    expect(r.calls.fulfilled).toBe(0);
  });

  it.each([['the request still alive', null], ['a refused connection', 'net::ERR_CONNECTION_REFUSED']])(
    'rethrows the forwarding error for %s',
    async (_name, errorText) => {
      const r = failingRoute(errorText);
      await expect((await handler())(r.route)).rejects.toThrow('route.fetch: Target page, context or browser has been closed');
      expect(r.calls.fulfilled).toBe(0);
    },
  );
});

describe('closeCat21WalletPage', () => {
  it('navigates the page away, then closes it', async () => {
    const steps: string[] = [];
    await closeCat21WalletPage({
      goto: async (url: string) => { steps.push(`goto ${url}`); return null; },
      close: async () => { steps.push('close'); },
    } as never);
    expect(steps).toEqual(['goto about:blank', 'close']);
  });
});
