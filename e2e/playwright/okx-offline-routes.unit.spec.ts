/**
 * @test-kind unit
 * Real:   installOkxOfflineRoutes, OKX_VENDOR_HOSTS, OKX_PRE_EXEC_ANSWER
 * Faked:  the BrowserContext (route/pages), the route (fulfill/abort) and the open pages (url/goto),
 *         shapes: @playwright/test types
 * Proves: OKX's welcome tab is answered with an empty local document, the sign popup's pre-execution check with
 *         the server's captured answer, every other request to an OKX host is aborted; nothing else is touched
 */
import { installOkxOfflineRoutes, OKX_PRE_EXEC_ANSWER, OKX_VENDOR_HOSTS, OKX_WELCOME_PAGE_URL } from './okx-offline-routes';

// A fake BrowserContext recording `route()` registrations and the pages it
// holds. The shield's IO boundary is exactly `context.route`, `route.fulfill`,
// `context.pages()` and `page.goto`.

type Matcher = (url: URL) => boolean;
type Handler = (route: {
  fulfill: (r: { status: number; contentType: string; body: string }) => Promise<void>;
  abort: (code: string) => Promise<void>;
  request: () => { postData: () => string | null };
}) => Promise<void>;

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
  /** What the route Playwright picks for `url` does: the last registered match wins. */
  async function handle(url: string, postData: string | null = null) {
    const { context, routes } = fakeContext();
    await installOkxOfflineRoutes(context);
    const matching = routes.filter((r) => r.matcher(new URL(url)));
    const outcome: { fulfilled?: { status: number; contentType: string; body: string }[]; aborted?: string } = {};
    if (matching.length === 0) return { outcome, matched: false };
    await matching[matching.length - 1].handler({
      fulfill: async (r) => { (outcome.fulfilled ??= []).push(r); },
      abort: async (code) => { outcome.aborted = code; },
      request: () => ({ postData: () => postData }),
    });
    return { outcome, matched: true };
  }

  it('answers the welcome tab locally with an empty document', async () => {
    const { outcome } = await handle(OKX_WELCOME_PAGE_URL);
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.fulfilled).toEqual([expect.objectContaining({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset="utf-8"><title>OKX welcome page (offline)</title>',
    })]);
  });

  it.each([
    'https://web3.okx.com/extension?lang=en',
    'https://web3.okx.com/extension#top',
  ])('answers the welcome page with query or fragment: %s', async (url) => {
    const { outcome } = await handle(url);
    expect(outcome.fulfilled).toHaveLength(1);
  });

  it.each([
    'https://wallet.okx.com/priapi/v1/wallet/tx/utxo/info',
    'https://wallet.okx.com/priapi/v1/wallet/tx/dapp/sign/prompt',
    'https://wallet.okex.org/priapi/df/list',
    'https://static.okx.com/cdn/i18n/web/okx/okx_extension_wallet/en_us.json',
    'https://static.coinall.ltd/cdn/assets/okfe/inner/wallet-config/hot.js',
    'https://web3.okx.com/cdn/assets/okfe/connect-wallet/common/847.31d6cfe0.css',
    'https://web3.okx.com/v1/deposit/plugin/heartbeat',
    'https://wallet.ouxyi.cash/v1/deposit/plugin/heartbeat',
    'https://web3.ouchyi.bid/v1/deposit/plugin/heartbeat',
    'https://web3.chouyi.pink/v1/deposit/plugin/heartbeat',
    'https://www.okx-httpdns.com/v2/support/doh/plugin/wallet',
    'https://www.okx-doh.com/v2/support/doh/plugin/wallet',
    'https://47.57.9.204/v2/support/doh/plugin/wallet',
    'https://47.75.96.239/v2/support/doh/plugin/wallet',
  ])('aborts the vendor request %s', async (url) => {
    const { outcome } = await handle(url);
    expect(outcome).toEqual({ aborted: 'failed' });
  });

  it.each([
    'http://localhost:4500/extension',
    'chrome-extension://ndgcomdemnmohchocefkkfipdkgiogon/notification.html',
    'https://evil.example/https://wallet.okx.com/',
    'https://okx.com.evil.example/',
    'https://147.57.9.204/',
  ])('leaves %s to the wallet', async (url) => {
    expect(OKX_VENDOR_HOSTS.test(url)).toBe(false);
    expect((await handle(url)).matched).toBe(false);
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

describe('installOkxOfflineRoutes: the pre-execution check', () => {
  it('answers it on both API hosts with the server\'s captured answer, inside the OKX envelope', async () => {
    // As wallet.okx.com and wallet.okex.org answered every signPsbt pre-execution
    // of the okx lane on 2026-10-11.
    expect(OKX_PRE_EXEC_ANSWER).toEqual({ popupInfoList: [], txInfo: null });
    const { context, routes } = fakeContext();
    await installOkxOfflineRoutes(context);
    for (const host of ['wallet.okx.com', 'wallet.okex.org']) {
      const url = new URL(`https://${host}/priapi/v2/wallet/tx/preExecTransactionv2?t=1791706825358`);
      const matching = routes.filter((r) => r.matcher(url));
      const fulfilled: { status: number; body: string }[] = [];
      await matching[matching.length - 1].handler({
        fulfill: async (r) => { fulfilled.push(r); },
        abort: async () => { throw new Error('aborted'); },
        request: () => ({ postData: () => '{"from":"bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr","method":"signPsbt","chainIndex":0}' }),
      });
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0].status).toBe(200);
      expect(JSON.parse(fulfilled[0].body)).toEqual({
        code: 0, msg: '', error_code: '0', error_message: '', detailMsg: '',
        data: { popupInfoList: [], txInfo: null },
      });
    }
  });

  it('leaves the same path on another host to the abort', async () => {
    const { context, routes } = fakeContext();
    await installOkxOfflineRoutes(context);
    const url = new URL('https://web3.okx.com/priapi/v2/wallet/tx/preExecTransactionv2');
    const matching = routes.filter((r) => r.matcher(url));
    const outcome: { aborted?: string } = {};
    await matching[matching.length - 1].handler({
      fulfill: async () => { throw new Error('fulfilled'); },
      abort: async (code) => { outcome.aborted = code; },
      request: () => ({ postData: () => null }),
    });
    expect(outcome).toEqual({ aborted: 'failed' });
  });
});
