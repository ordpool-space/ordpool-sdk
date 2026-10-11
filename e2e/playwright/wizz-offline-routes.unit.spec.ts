/**
 * @test-kind unit
 * Real:   installWizzOfflineRoutes, recommendedFeesFixture (ordpool-sdk/testing)
 * Faked:  the BrowserContext (route) and the route (fulfill), shapes: @playwright/test types
 * Proves: Wizz's fee lookup on mempool.space is answered with the SDK's captured sample, and only that URL
 */
import { recommendedFeesFixture } from 'ordpool-sdk/testing';
import { installWizzOfflineRoutes, WIZZ_RECOMMENDED_FEES_URL } from './wizz-offline-routes';

// A fake BrowserContext recording `route()` registrations. The shield's IO
// boundary is exactly `context.route` and `route.fulfill`.

interface Fulfilled { status: number; contentType: string; headers: Record<string, string>; body: string }
type Handler = (route: { fulfill: (r: Fulfilled) => Promise<void>; request: () => unknown }) => Promise<void>;

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
