/**
 * @test-kind unit
 * Real:   closeLeftoverExtensionPages, installCat21WalletOrdRoutes, closeCat21WalletPage
 * Faked:  the BrowserContext (pages/route) and its pages (url/isClosed/goto/close), shapes: @playwright/test types
 * Proves: in a context with Cat21 Wallet's ord routes, a leftover extension page is navigated away before it
 *         closes; elsewhere it is closed directly; kept and non-extension pages stay open; a page that closes
 *         itself mid-cleanup ends the cleanup quietly and any other close failure fails it
 */
import { closeLeftoverExtensionPages } from './approval-popup';
import { installCat21WalletOrdRoutes } from './cat21wallet-ord-routes';

interface FakePage {
  steps: string[];
  closed: boolean;
  url: () => string;
  isClosed: () => boolean;
  goto: (url: string) => Promise<null>;
  close: () => Promise<void>;
}

function fakePage(url: string, opts: { closesItselfOnGoto?: boolean; closeFails?: boolean } = {}): FakePage {
  const page: FakePage = {
    steps: [],
    closed: false,
    url: () => url,
    isClosed: () => page.closed,
    goto: async (to: string) => {
      page.steps.push(`goto ${to}`);
      if (opts.closesItselfOnGoto) {
        page.closed = true;
        throw new Error('page.goto: Target page, context or browser has been closed');
      }
      return null;
    },
    close: async () => {
      page.steps.push('close');
      if (opts.closeFails) throw new Error('page.close: protocol error');
      page.closed = true;
    },
  };
  return page;
}

function fakeContext(pages: FakePage[]) {
  return {
    pages: () => pages,
    route: async () => undefined,
  };
}

const EXT = 'chrome-extension://abcdefghijklmnop/popup.html';

describe('closeLeftoverExtensionPages', () => {
  it('navigates a Cat21 Wallet page away before closing it', async () => {
    const leftover = fakePage(EXT);
    const context = fakeContext([leftover]);
    await installCat21WalletOrdRoutes(context as never, { ordUrl: 'http://localhost:28080' });

    await closeLeftoverExtensionPages(context as never, []);

    expect(leftover.steps).toEqual(['goto about:blank', 'close']);
  });

  it('closes an extension page directly in a context without Cat21 Wallet ord routes', async () => {
    const leftover = fakePage(EXT);
    await closeLeftoverExtensionPages(fakeContext([leftover]) as never, []);
    expect(leftover.steps).toEqual(['close']);
  });

  it('leaves kept pages and non-extension pages open', async () => {
    const kept = fakePage(EXT);
    const app = fakePage('http://localhost:4200/');
    const leftover = fakePage(EXT);
    const context = fakeContext([kept, app, leftover]);
    await installCat21WalletOrdRoutes(context as never, { ordUrl: 'http://localhost:28080' });

    await closeLeftoverExtensionPages(context as never, [kept as never]);

    expect(kept.steps).toEqual([]);
    expect(app.steps).toEqual([]);
    expect(leftover.steps).toEqual(['goto about:blank', 'close']);
  });

  it('ends quietly when the wallet closes its page during the cleanup', async () => {
    const closing = fakePage(EXT, { closesItselfOnGoto: true });
    const after = fakePage(EXT);
    const context = fakeContext([closing, after]);
    await installCat21WalletOrdRoutes(context as never, { ordUrl: 'http://localhost:28080' });

    await closeLeftoverExtensionPages(context as never, []);

    expect(closing.steps).toEqual(['goto about:blank']);
    expect(after.steps).toEqual(['goto about:blank', 'close']);
  });

  it('rethrows a close that fails while the page is still open', async () => {
    const stuck = fakePage(EXT, { closeFails: true });
    await expect(closeLeftoverExtensionPages(fakeContext([stuck]) as never, [])).rejects.toThrow(
      'page.close: protocol error',
    );
  });
});
