/**
 * @test-kind unit
 * Real:   raceApprovalPopup and the popup search behind waitForApprovalPopup
 * Faked:  the BrowserContext (pages(), on('page'), off('page')), the popup Page (title(), isClosed()) and the
 *         no-popup locator (waitFor), each reduced to the members the helper calls (shapes: @playwright/test types)
 * Proves: the race reports whichever of "popup" and "no-popup state" happened first, stops the losing popup
 *         search, absorbs the loser's later rejection, and rejects when either side fails before a winner exists
 */
import { raceApprovalPopup } from './approval-popup';

/** A context whose `page` listeners the test fires by hand, recording on/off. */
function controllableContext(initial: unknown[] = []) {
  const listeners = new Set<(p: unknown) => void>();
  return {
    listeners,
    open: (p: unknown) => listeners.forEach((fn) => fn(p)),
    context: {
      pages: () => initial,
      on: (_event: string, fn: (p: unknown) => void) => { listeners.add(fn); },
      off: (_event: string, fn: (p: unknown) => void) => { listeners.delete(fn); },
    },
  };
}

const livePage = (name: string) => ({ title: () => Promise.resolve(name), isClosed: () => false });

/** A no-popup state the test resolves or rejects by hand. */
function controllableState() {
  let resolve: () => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const waits: unknown[] = [];
  return {
    waits,
    appear: () => resolve(),
    fail: (e: unknown) => reject(e),
    state: {
      waitFor: (options: { state: 'visible' }) => {
        waits.push(options);
        return new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      },
    },
  };
}

describe('raceApprovalPopup', () => {
  it('reports the popup when it appears first, and stops listening for pages', async () => {
    const ctx = controllableContext();
    const st = controllableState();
    const popup = livePage('connect');
    const race = raceApprovalPopup({
      context: ctx.context as never,
      knownPages: new Set(),
      isApproval: () => true,
      noPopupState: st.state,
    });
    ctx.open(popup);
    expect(await race).toEqual({ outcome: 'popup', page: popup });
    expect(ctx.listeners.size).toBe(0);
    // The no-popup side was waited on as a visible state, under the config's bound.
    expect(st.waits).toEqual([{ state: 'visible' }]);
  });

  it('reports no-popup when the exclusive app state appears first, and stops the popup search', async () => {
    const ctx = controllableContext();
    const st = controllableState();
    const race = raceApprovalPopup({
      context: ctx.context as never,
      knownPages: new Set(),
      isApproval: () => true,
      noPopupState: st.state,
    });
    expect(ctx.listeners.size).toBe(1);
    st.appear();
    expect(await race).toEqual({ outcome: 'no-popup' });
    expect(ctx.listeners.size).toBe(0);
  });

  it('finds a popup that was already open when the race started', async () => {
    const already = livePage('already open');
    const ctx = controllableContext([already]);
    const st = controllableState();
    const race = await raceApprovalPopup({
      context: ctx.context as never,
      knownPages: new Set(),
      isApproval: () => true,
      noPopupState: st.state,
    });
    expect(race).toEqual({ outcome: 'popup', page: already });
  });

  it('absorbs the losing state wait rejecting after the popup won', async () => {
    // At teardown the app page closes and its pending waitFor rejects. The race
    // was decided long before, so that rejection must not surface anywhere.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const ctx = controllableContext();
      const st = controllableState();
      const popup = livePage('connect');
      const race = raceApprovalPopup({
        context: ctx.context as never,
        knownPages: new Set(),
        isApproval: () => true,
        noPopupState: st.state,
      });
      ctx.open(popup);
      expect(await race).toEqual({ outcome: 'popup', page: popup });
      st.fail(new Error('locator.waitFor: Target page, context or browser has been closed'));
      // Two macrotask turns: Node reports an unhandled rejection after the
      // microtask queue drains, so a leak would be recorded by then.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects when the no-popup state fails before either side won', async () => {
    const ctx = controllableContext();
    const st = controllableState();
    const race = raceApprovalPopup({
      context: ctx.context as never,
      knownPages: new Set(),
      isApproval: () => true,
      noPopupState: st.state,
    });
    st.fail(new Error('page closed'));
    await expect(race).rejects.toThrow('page closed');
    expect(ctx.listeners.size).toBe(0);
  });

  it('rejects when the context cannot be read, rather than reading it as no popup', async () => {
    const st = controllableState();
    const broken = {
      pages: () => { throw new Error('context disposed'); },
      on: () => undefined,
      off: () => undefined,
    };
    await expect(raceApprovalPopup({
      context: broken as never,
      knownPages: new Set(),
      isApproval: () => true,
      noPopupState: st.state,
    })).rejects.toThrow('context disposed');
  });

  it('ignores a page in knownPages and reports the new popup', async () => {
    const stale = livePage('dashboard');
    const ctx = controllableContext([stale]);
    const st = controllableState();
    const fresh = livePage('connect');
    const race = raceApprovalPopup({
      context: ctx.context as never,
      knownPages: new Set([stale as never]),
      isApproval: () => true,
      noPopupState: st.state,
    });
    ctx.open(fresh);
    expect(await race).toEqual({ outcome: 'popup', page: fresh });
  });
});
