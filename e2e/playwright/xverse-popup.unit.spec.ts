/**
 * @test-kind unit
 * Real:   unlockXverseControls, approveXverseConnect and the popup search and close-requiring click beneath it
 * Faked:  the clock (jest fake timers), the BrowserContext (pages/on/off) and the Xverse pages and controls
 *         (shapes: @playwright/test types)
 * Proves: the lock screen is answered only when Xverse shows it, the connect popup is the NEW page with the
 *         consent button, its click must close it, and a request that failed is reported as itself
 */
import { e2eTimeoutMs } from '../e2e-timeout';
import { approveXverseConnect, unlockXverseControls, XVERSE_CONNECT_BUTTON } from './xverse-popup';

describe('unlockXverseControls', () => {
  function controls(locked: boolean) {
    const calls: string[] = [];
    return {
      calls,
      controls: {
        settled: { waitFor: async () => { calls.push('settled'); } },
        password: {
          isVisible: async () => { calls.push('password?'); return locked; },
          fill: async (v: string) => { calls.push(`fill:${v}`); },
        },
        unlock: { click: async () => { calls.push('unlock'); } },
        home: { waitFor: async () => { calls.push('home'); } },
      } as unknown as Parameters<typeof unlockXverseControls>[0],
    };
  }

  it('on the lock screen: types the password, clicks Unlock, then waits for the home screen', async () => {
    const { calls, controls: c } = controls(true);
    await unlockXverseControls(c, 'pw-1');
    expect(calls).toEqual(['settled', 'password?', 'fill:pw-1', 'unlock', 'home']);
  });

  it('already unlocked: touches nothing and waits for the home screen', async () => {
    const { calls, controls: c } = controls(false);
    await unlockXverseControls(c, 'pw-1');
    expect(calls).toEqual(['settled', 'password?', 'home']);
  });

  it('fails when the home screen never shows', async () => {
    const { controls: c } = controls(true);
    (c.home as { waitFor: () => Promise<void> }).waitFor = () => Promise.reject(new Error('home: timeout'));
    await expect(unlockXverseControls(c, 'pw-1')).rejects.toThrow('home: timeout');
  });
});

/** A fake Xverse page: a consent button that may or may not close the page when clicked. */
function fakePage(name: string, opts: { hasConsent: boolean; closesOnClick: boolean }) {
  let closed = false;
  let markClosed: () => void = () => undefined;
  /** Resolves when a click closed the page: the wallet answering the dapp. */
  const whenClosed = new Promise<void>((r) => { markClosed = r; });
  const clicks: string[] = [];
  const names: unknown[] = [];
  const consent = {
    waitFor: () => (opts.hasConsent ? Promise.resolve() : new Promise<void>(() => undefined)),
    click: async () => {
      clicks.push(name);
      if (opts.closesOnClick) {
        closed = true;
        markClosed();
      }
    },
    isVisible: async () => !closed,
    isEnabled: async () => !closed,
  };
  const page = {
    name,
    clicks,
    whenClosed,
    names,
    title: async () => name,
    isClosed: () => closed,
    getByRole: (_role: string, o: { name: unknown }) => {
      names.push(o.name);
      return { first: () => consent };
    },
  };
  return page;
}

type FakePage = ReturnType<typeof fakePage>;

function fakeContext(initial: FakePage[]) {
  const pages = [...initial];
  const listeners: ((p: FakePage) => void)[] = [];
  return {
    pages: () => pages,
    on: (_e: string, fn: (p: FakePage) => void) => { listeners.push(fn); },
    off: (_e: string, fn: (p: FakePage) => void) => { listeners.splice(listeners.indexOf(fn), 1); },
    open(p: FakePage) {
      pages.push(p);
      for (const l of [...listeners]) l(p);
    },
  };
}

describe('approveXverseConnect', () => {
  afterEach(() => jest.useRealTimers());

  it('approves the popup the request opened and returns what the request resolved to', async () => {
    const primer = fakePage('primer', { hasConsent: true, closesOnClick: false });
    const ctx = fakeContext([primer]);
    const popup = fakePage('connect', { hasConsent: true, closesOnClick: true });

    const result = await approveXverseConnect(ctx as never, async () => {
      ctx.open(popup);
      // Resolves once the wallet answered, i.e. after the consent click.
      await popup.whenClosed;
      return { paymentAddress: 'bcrt1q-answer' };
    });

    expect(result).toEqual({ paymentAddress: 'bcrt1q-answer' });
    // The page open before the request (it shows a matching button too) is
    // never the popup: only the new one was clicked.
    expect(primer.clicks).toEqual([]);
    expect(popup.clicks).toEqual(['connect']);
    expect(popup.names).toContain(XVERSE_CONNECT_BUTTON);
  });

  it('fails at the click when the popup stays open after it', async () => {
    jest.useFakeTimers();
    const ctx = fakeContext([]);
    const popup = fakePage('connect', { hasConsent: true, closesOnClick: false });
    const run = approveXverseConnect(ctx as never, () => {
      ctx.open(popup);
      return new Promise<never>(() => undefined);
    });
    const assertion = expect(run).rejects.toThrow(/Xverse connect popup: clicked the confirm button and the popup did not close/);
    await jest.advanceTimersByTimeAsync(e2eTimeoutMs() + 1_000);
    await assertion;
    expect(popup.clicks).toEqual(['connect']);
  });

  it('reports the request\'s own failure when no popup came', async () => {
    jest.useFakeTimers();
    const ctx = fakeContext([]);
    const run = approveXverseConnect(ctx as never, () => Promise.reject(new Error('Xverse: network mismatch')));
    const assertion = expect(run).rejects.toThrow('Xverse: network mismatch');
    await jest.advanceTimersByTimeAsync(e2eTimeoutMs() + 1_000);
    await assertion;
  });

  it('reports the search\'s failure when no popup came and the request is still pending', async () => {
    jest.useFakeTimers();
    const ctx = fakeContext([]);
    const run = approveXverseConnect(ctx as never, () => new Promise<never>(() => undefined));
    const assertion = expect(run).rejects.toThrow(/no page in the context satisfied isApproval/);
    await jest.advanceTimersByTimeAsync(e2eTimeoutMs() + 1_000);
    await assertion;
  });

  it('reports the request\'s failure when it rejects after a click that closed the popup', async () => {
    const ctx = fakeContext([]);
    const popup = fakePage('connect', { hasConsent: true, closesOnClick: true });
    await expect(approveXverseConnect(ctx as never, async () => {
      ctx.open(popup);
      await popup.whenClosed;
      throw new Error('User rejected the request');
    })).rejects.toThrow('User rejected the request');
  });
});
