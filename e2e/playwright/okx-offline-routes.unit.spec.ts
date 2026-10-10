import { installOkxOfflineRoutes, OKX_WELCOME_PAGE_URL } from './okx-offline-routes';

// A fake BrowserContext recording `route()` registrations and the pages it
// holds. The shield's IO boundary is exactly `context.route`, `route.fulfill`,
// `context.pages()` and `page.goto`.

type Matcher = (url: URL) => boolean;
type Handler = (route: { fulfill: (r: { status: number; contentType: string; body: string }) => Promise<void> }) => Promise<void>;

function fakeContext(openUrls: string[] = []) {
  const routes: { matcher: Matcher; handler: Handler }[] = [];
  const gotos: string[] = [];
  const pages = openUrls.map((url) => ({
    url: () => url,
    goto: async (target: string) => { gotos.push(target); },
  }));
  const context = {
    route: async (matcher: Matcher, handler: Handler) => { routes.push({ matcher, handler }); },
    pages: () => pages,
  };
  return { context: context as unknown as Parameters<typeof installOkxOfflineRoutes>[0], routes, gotos };
}

describe('installOkxOfflineRoutes', () => {
  it('answers the welcome tab locally with an empty document', async () => {
    const { context, routes } = fakeContext();
    await installOkxOfflineRoutes(context);

    const matching = routes.filter((r) => r.matcher(new URL(OKX_WELCOME_PAGE_URL)));
    expect(matching).toHaveLength(1);
    const fulfilled: { status: number; contentType: string; body: string }[] = [];
    await matching[0].handler({ fulfill: async (r) => { fulfilled.push(r); } });
    expect(fulfilled).toEqual([expect.objectContaining({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset="utf-8"><title>OKX welcome page (offline)</title>',
    })]);
  });

  it.each([
    'https://web3.okx.com/extension?lang=en',
    'https://web3.okx.com/extension#top',
  ])('matches the welcome page with query or fragment: %s', async (url) => {
    const { context, routes } = fakeContext();
    await installOkxOfflineRoutes(context);
    expect(routes.some((r) => r.matcher(new URL(url)))).toBe(true);
  });

  it.each([
    'https://wallet.okx.com/priapi/v1/wallet/tx/utxo/info',
    'https://web3.okx.com/cdn/assets/okfe/connect-wallet/common/847.31d6cfe0.css',
    'http://localhost:4500/extension',
    'chrome-extension://ndgcomdemnmohchocefkkfipdkgiogon/notification.html',
  ])('leaves %s to the wallet', async (url) => {
    const { context, routes } = fakeContext();
    await installOkxOfflineRoutes(context);
    expect(routes.some((r) => r.matcher(new URL(url)))).toBe(false);
  });

  it('reloads a welcome tab that is already open, and only that one', async () => {
    const { context, gotos } = fakeContext([
      'chrome-extension://ndgcomdemnmohchocefkkfipdkgiogon/popup-init.html',
      OKX_WELCOME_PAGE_URL,
      'about:blank',
    ]);
    await installOkxOfflineRoutes(context);
    expect(gotos).toEqual([OKX_WELCOME_PAGE_URL]);
  });
});
