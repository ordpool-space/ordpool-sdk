/**
 * @test-kind unit
 * Real:   installPhantomOfflineRoutes, PHANTOM_VENDOR_HOSTS
 * Faked:  the BrowserContext (route) and the route (abort/fulfill), shapes: @playwright/test types
 * Proves: every request to a Phantom host is aborted, and nothing else is routed
 */
import { installPhantomOfflineRoutes, PHANTOM_VENDOR_HOSTS } from './phantom-offline-routes';

type Handler = (route: { abort: (code: string) => Promise<void>; fulfill: () => Promise<void> }) => Promise<void>;

async function installed() {
  const routes: { pattern: RegExp; handler: Handler }[] = [];
  await installPhantomOfflineRoutes({ route: async (pattern: RegExp, handler: Handler) => { routes.push({ pattern, handler }); } } as never);
  expect(routes).toHaveLength(1);
  return routes[0];
}

describe('installPhantomOfflineRoutes', () => {
  it.each([
    'https://api.phantom.app/discover/v1',
    'https://api.phantom.app/v1/wallets/kms/rpc',
    'https://auth.phantom.app/oauth2/token',
    'https://time.phantom.app/utc',
    'https://data.phantom.app/v1/batch',
    'https://eppo-proxy.phantom.app/api/flag-config/v1/config',
    'https://sanity-proxy-v2.phantom.app/v1/data/query/production',
    'https://blowfish-blocklist-proxy.phantom.app/',
    'https://sentry-intake.datadoghq.com/api/1/envelope/?sentry_version=7',
  ])('aborts %s', async (url) => {
    const { pattern, handler } = await installed();
    expect(pattern.test(url)).toBe(true);
    const outcome: { aborted?: string; fulfilled?: boolean } = {};
    await handler({
      abort: async (code) => { outcome.aborted = code; },
      fulfill: async () => { outcome.fulfilled = true; },
    });
    expect(outcome).toEqual({ aborted: 'failed' });
  });

  it.each([
    'http://localhost:4500/',
    'chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa/popup.html',
    'https://phantom.app.evil.example/',
    'https://evil.example/https://api.phantom.app/',
    'https://app.datadoghq.com/',
  ])('leaves %s alone', (url) => {
    expect(PHANTOM_VENDOR_HOSTS.test(url)).toBe(false);
  });
});
