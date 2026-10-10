import { EventEmitter } from 'node:events';
import { installContextErrorGuard } from './browser-error-guard';

// The guard's inputs are Playwright's page events. These fakes emit the same
// event names with objects carrying exactly the members the guard reads
// (`page.url()`, `msg.type()`, `msg.text()`, `request.failure()`,
// `request.method()`, `request.url()`), so the guard runs unchanged.

class FakePage extends EventEmitter {
  constructor(private readonly href: string) { super(); }
  url(): string { return this.href; }

  consoleError(text: string): void {
    this.emit('console', { type: () => 'error', text: () => text });
  }

  consoleWarning(text: string): void {
    this.emit('console', { type: () => 'warning', text: () => text });
  }

  requestFailed(method: string, url: string, errorText: string): void {
    this.emit('requestfailed', { method: () => method, url: () => url, failure: () => ({ errorText }) });
  }
}

function setup(): { guard: ReturnType<typeof installContextErrorGuard>; openPage: (url: string) => FakePage } {
  const context = new EventEmitter();
  const guard = installContextErrorGuard(context as unknown as Parameters<typeof installContextErrorGuard>[0]);
  return {
    guard,
    openPage(url: string): FakePage {
      const page = new FakePage(url);
      context.emit('page', page);
      return page;
    },
  };
}

const APP = 'http://localhost:4200/cat21-mint';
const BROADCAST_400 = 'Failed to load resource: the server responded with a status of 400 (Bad Request)';
const BROADCAST_REASON = 'the spec fulfils POST /api/tx with 400 to prove the broadcast error path';

describe('installContextErrorGuard', () => {
  it('passes when the expected error is the only one recorded', () => {
    const { guard, openPage } = setup();
    const app = openPage(APP);
    guard.expectBrowserError(/status of 400 \(Bad Request\)/, BROADCAST_REASON);
    app.consoleError(BROADCAST_400);

    expect(() => guard.assertClean()).not.toThrow();
  });

  it('fails with the named message when the expected error never appears', () => {
    const { guard, openPage } = setup();
    openPage(APP);
    guard.expectBrowserError(/status of 400 \(Bad Request\)/, BROADCAST_REASON);

    expect(() => guard.assertClean()).toThrow(
      'expected the provoked error /status of 400 \\(Bad Request\\)/ ' +
      '(the spec fulfils POST /api/tx with 400 to prove the broadcast error path) but it never appeared',
    );
  });

  it('fails on an error next to the expected one, and names only the unexpected one', () => {
    const { guard, openPage } = setup();
    const app = openPage(APP);
    guard.expectBrowserError(/status of 400 \(Bad Request\)/, BROADCAST_REASON);
    app.consoleError(BROADCAST_400);
    app.consoleError('TypeError: cannot read properties of undefined');

    let message = '';
    try { guard.assertClean(); } catch (e) { message = (e as Error).message; }
    expect(message).toBe(
      'Browser surfaced 1 unexpected error(s):\n\n[console.error] TypeError: cannot read properties of undefined',
    );
  });

  it('fails on an unexpected error when nothing is expected', () => {
    const { guard, openPage } = setup();
    openPage(APP).emit('pageerror', new Error('boom'));

    expect(() => guard.assertClean()).toThrow(/^Browser surfaced 1 unexpected error\(s\):\n\n\[pageerror\] boom/);
  });

  it('appends the failed requests of guarded pages so a bare ERR_FAILED names its URL', () => {
    const { guard, openPage } = setup();
    const tab = openPage('https://web3.okx.com/extension');
    tab.requestFailed('GET', 'chrome-extension://invalid/', 'net::ERR_FAILED');
    tab.consoleError('Failed to load resource: net::ERR_FAILED');

    expect(() => guard.assertClean()).toThrow(
      'Browser surfaced 1 unexpected error(s):\n\n' +
      '[console.error] Failed to load resource: net::ERR_FAILED\n\n' +
      'Requests that failed on guarded pages:\n' +
      '  - net::ERR_FAILED GET chrome-extension://invalid/',
    );
  });

  it('leaves wallet-extension pages and console warnings outside the guard', () => {
    const { guard, openPage } = setup();
    const popup = openPage('chrome-extension://abcdef/notification.html');
    popup.consoleError('[Wallet] internal error');
    popup.requestFailed('POST', 'https://wallet.example/api', 'net::ERR_ABORTED');
    openPage(APP).consoleWarning('deprecated meta tag');

    expect(() => guard.assertClean()).not.toThrow();
  });

  it('scopes an expectation to one test: assertClean consumes it', () => {
    const { guard, openPage } = setup();
    const app = openPage(APP);
    guard.expectBrowserError(/status of 400 \(Bad Request\)/, BROADCAST_REASON);
    app.consoleError(BROADCAST_400);
    guard.assertClean();

    app.consoleError(BROADCAST_400);
    expect(() => guard.assertClean()).toThrow(/^Browser surfaced 1 unexpected error/);
  });

  it('resetPerTest drops recorded errors and expectations', () => {
    const { guard, openPage } = setup();
    openPage(APP).consoleError('left over from beforeAll');
    guard.expectBrowserError(/status of 400 \(Bad Request\)/, BROADCAST_REASON);
    guard.resetPerTest();

    expect(() => guard.assertClean()).not.toThrow();
  });

  it.each([
    [/Failed/],
    [/net::ERR_/],
    [/.*/],
    [/[\s\S]*cancel[\s\S]*|x/],
    [/(?:Failed)?.{0,1000}/],
  ])('refuses %s as too short or catch-all', (pattern) => {
    const { guard } = setup();
    expect(() => guard.expectBrowserError(pattern, BROADCAST_REASON)).toThrow(/does not name one specific message/);
  });

  it('refuses a stateful g or y pattern', () => {
    const { guard } = setup();
    expect(() => guard.expectBrowserError(/status of 400 \(Bad Request\)/g, BROADCAST_REASON)).toThrow(/carries the g or y flag/);
  });

  it.each([[''], ['expected'], ['   flaky test    ']])('refuses the reason %j', (reason) => {
    const { guard } = setup();
    expect(() => guard.expectBrowserError(/status of 400 \(Bad Request\)/, reason)).toThrow(/must name the action that provokes the error/);
  });
});
