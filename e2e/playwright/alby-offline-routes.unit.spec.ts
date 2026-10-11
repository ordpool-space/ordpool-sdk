/**
 * @test-kind unit
 * Real:   installAlbyOfflineRoutes, ALBY_LNDHUB_PLACEHOLDER_URL
 * Faked:  the BrowserContext (route) and the route (abort), shapes: @playwright/test types
 * Proves: requests to the seeded account's placeholder LNDHub are aborted, and nothing else is routed
 */
import { ALBY_LNDHUB_PLACEHOLDER_URL, installAlbyOfflineRoutes } from './alby-offline-routes';

type Matcher = (url: URL) => boolean;
type Handler = (route: { abort: (code: string) => Promise<void> }) => Promise<void>;

async function installed() {
  const routes: { matcher: Matcher; handler: Handler }[] = [];
  await installAlbyOfflineRoutes({ route: async (matcher: Matcher, handler: Handler) => { routes.push({ matcher, handler }); } } as never);
  expect(routes).toHaveLength(1);
  return routes[0];
}

describe('installAlbyOfflineRoutes', () => {
  it('names an address under .invalid, which no host can answer', () => {
    expect(ALBY_LNDHUB_PLACEHOLDER_URL).toBe('https://example.invalid');
  });

  it.each([
    'https://example.invalid/auth',
    'https://example.invalid/balance?x=1',
  ])('aborts %s', async (url) => {
    const { matcher, handler } = await installed();
    expect(matcher(new URL(url))).toBe(true);
    const outcome: { aborted?: string } = {};
    await handler({ abort: async (code) => { outcome.aborted = code; } });
    expect(outcome).toEqual({ aborted: 'failed' });
  });

  it.each([
    'http://localhost:4500/',
    'https://getalby.com/api',
    'https://example.invalid.evil.example/auth',
    'http://example.invalid/auth',
  ])('leaves %s alone', async (url) => {
    const { matcher } = await installed();
    expect(matcher(new URL(url))).toBe(false);
  });
});
