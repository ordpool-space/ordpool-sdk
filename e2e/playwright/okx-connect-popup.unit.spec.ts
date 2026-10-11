/**
 * @test-kind unit
 * Real:   OKX_CONNECT_URL, waitForOkxConnectApproval, approveOkxConnectPopup, and the popup search and
 *         approvalGate behind them
 * Faked:  the BrowserContext (pages/on/off) and its pages (url/waitForURL/getByRole/title/isClosed/close),
 *         shapes from @playwright/test's types; a page "navigates" by changing its URL
 * Proves: OKX's connect request is found on a page that was open before the dapp asked and navigates to
 *         #/connect/<id> later, as well as on a new page; a sign page with a Connect-looking button is not taken
 */
import { EventEmitter } from 'node:events';

import { OKX_CONNECT_URL, approveOkxConnectPopup, waitForOkxConnectApproval } from './okx-connect-popup';

const EXT = 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge';

/** A page whose URL and Connect button the test drives. */
class FakePage {
  private readonly events = new EventEmitter();
  private closed = false;
  private buttonShown = false;
  clicks = 0;

  constructor(private current: string, readonly name: string) {}

  url(): string {
    return this.current;
  }

  navigate(url: string): void {
    this.current = url;
    this.events.emit('nav');
  }

  showConnectButton(): void {
    this.buttonShown = true;
    this.events.emit('button');
  }

  waitForURL(re: RegExp): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!re.test(this.current)) return;
        this.events.off('nav', check);
        resolve();
      };
      this.events.on('nav', check);
      check();
    });
  }

  getByRole(_role: 'button', _opts: { name: RegExp }) {
    const first = {
      waitFor: () => new Promise<void>((resolve) => {
        const check = () => {
          if (!this.buttonShown) return;
          this.events.off('button', check);
          resolve();
        };
        this.events.on('button', check);
        check();
      }),
      // OKX closes the page the moment it accepts the click.
      click: async () => { this.clicks += 1; this.closed = true; },
      isVisible: async () => this.buttonShown && !this.closed,
      isEnabled: async () => true,
    };
    return { first: () => first };
  }

  title(): Promise<string> {
    return Promise.resolve(this.name);
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/** A context whose `page` listeners the test can fire. */
function fakeContext(initial: FakePage[]) {
  const events = new EventEmitter();
  const pages = [...initial];
  return {
    context: {
      pages: () => pages,
      on: (event: string, fn: (p: unknown) => void) => events.on(event, fn),
      off: (event: string, fn: (p: unknown) => void) => events.off(event, fn),
    },
    open(page: FakePage) {
      pages.push(page);
      events.emit('page', page);
    },
  };
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((r) => setImmediate(r));

describe('OKX_CONNECT_URL', () => {
  it.each([
    `${EXT}/notification.html#/connect/8f2e0c`,
    `${EXT}/popup.html#/connect/1`,
    `${EXT}/notification.html?type=dapp#/connect/1`,
    `${EXT}/notification.html#/connect?id=1`,
  ])('matches %s', (url) => {
    expect(OKX_CONNECT_URL.test(url)).toBe(true);
  });

  it.each([
    `${EXT}/notification.html#/connect-site`,
    `${EXT}/notification.html#/sign/1`,
    `${EXT}/home.html#/connect/1`,
    'http://localhost:4500/#/connect/1',
  ])('does not match %s', (url) => {
    expect(OKX_CONNECT_URL.test(url)).toBe(false);
  });
});

describe('waitForOkxConnectApproval', () => {
  it('takes the window that was already open when the request arrives in it', async () => {
    const installWindow = new FakePage(`${EXT}/notification.html#/home`, 'install window');
    const harness = new FakePage('http://localhost:4500/', 'harness');
    const ctx = fakeContext([installWindow, harness]);

    const found = waitForOkxConnectApproval({ context: ctx.context as never });
    await settle();
    installWindow.navigate(`${EXT}/notification.html#/connect/8f2e0c`);
    installWindow.showConnectButton();

    expect(await found).toBe(installWindow as never);
  });

  it('takes a new page opened on the connect route', async () => {
    const ctx = fakeContext([new FakePage('http://localhost:4500/', 'harness')]);
    const found = waitForOkxConnectApproval({ context: ctx.context as never });
    await settle();
    const popup = new FakePage(`${EXT}/popup.html#/connect/1`, 'new popup');
    ctx.open(popup);
    popup.showConnectButton();

    expect(await found).toBe(popup as never);
  });

  it('passes over a sign page whose button also reads Connect, and takes the connect page after it', async () => {
    const sign = new FakePage(`${EXT}/notification.html#/sign/1`, 'sign popup');
    sign.showConnectButton();
    const ctx = fakeContext([sign]);
    const found = waitForOkxConnectApproval({ context: ctx.context as never });
    await settle();
    const connect = new FakePage(`${EXT}/notification.html#/connect/2`, 'connect popup');
    ctx.open(connect);
    connect.showConnectButton();

    expect(await found).toBe(connect as never);
  });
});

describe('approveOkxConnectPopup', () => {
  it('clicks Connect once on the already-open window and returns it once OKX closed it', async () => {
    const installWindow = new FakePage(`${EXT}/notification.html#/home`, 'install window');
    const ctx = fakeContext([installWindow]);
    const approved = approveOkxConnectPopup({ context: ctx.context as never });
    await settle();
    installWindow.navigate(`${EXT}/notification.html#/connect/8f2e0c`);
    installWindow.showConnectButton();

    expect(await approved).toBe(installWindow as never);
    expect(installWindow.clicks).toBe(1);
    expect(installWindow.isClosed()).toBe(true);
  });
});
