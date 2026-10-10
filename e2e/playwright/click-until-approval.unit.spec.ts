/**
 * @test-kind unit
 * Real:   clickUntilApprovalPopup and the popup search behind it
 * Faked:  the clock (jest fake timers), the BrowserContext (pages/on/off), the popup page (title/isClosed) and the
 *         trigger (click/isVisible/isEnabled) (shapes: @playwright/test types)
 * Proves: a swallowed click is re-sent after the probe, a trigger that reacted is never clicked twice
 */
import { POPUP_AFTER_CLICK_PROBE_MS, clickUntilApprovalPopup } from './approval-popup';

/** A context whose `page` event fires only after `appearsAfterClicks` clicks. */
function harness(opts: { appearsAfterClicks: number; triggerReactsToClick?: boolean }) {
  const state = { clicks: 0 };
  const page = { title: async () => 'popup', isClosed: () => false } as never;
  const listeners = new Set<(p: unknown) => void>();

  const context = {
    on: (_e: string, cb: (p: unknown) => void) => { listeners.add(cb); },
    off: (_e: string, cb: (p: unknown) => void) => { listeners.delete(cb); },
    pages: () => (state.clicks >= opts.appearsAfterClicks ? [page] : []),
  } as never;

  const trigger = {
    click: async () => {
      state.clicks++;
      if (state.clicks >= opts.appearsAfterClicks) {
        // The wallet opens its popup: the context announces a new page.
        setTimeout(() => listeners.forEach((cb) => cb(page)), 0);
      }
    },
    isVisible: async () => !(opts.triggerReactsToClick && state.clicks > 0),
    isEnabled: async () => !(opts.triggerReactsToClick && state.clicks > 0),
  };

  /** The wallet opens its popup on its own, late, without any further click. */
  const openLate = () => {
    state.clicks = Math.max(state.clicks, opts.appearsAfterClicks);
    listeners.forEach((cb) => cb(page));
  };

  return { state, context, trigger, page, listeners, openLate };
}

const opts = (h: ReturnType<typeof harness>) => ({
  context: h.context,
  knownPages: new Set<never>(),
  isApproval: () => true,
  label: 'mint-cta',
});

// The probe after each click is a real 20s duration; fake timers run it.
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('clickUntilApprovalPopup', () => {
  it('sends one click when the wallet pops up', async () => {
    const h = harness({ appearsAfterClicks: 1 });
    const result = clickUntilApprovalPopup(h.trigger, opts(h) as never);
    await jest.advanceTimersByTimeAsync(0);
    const res = await result;
    expect({ clicks: res.clicks, page: res.page }).toEqual({ clicks: 1, page: h.page });
  });

  it('re-clicks a trigger that never reacted after the probe ran out: the swallowed click, not a sleeping wallet', async () => {
    const h = harness({ appearsAfterClicks: 2 });
    const result = clickUntilApprovalPopup(h.trigger, opts(h) as never);
    await jest.advanceTimersByTimeAsync(POPUP_AFTER_CLICK_PROBE_MS - 1);
    expect(h.state.clicks).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    const res = await result;
    expect(res.clicks).toBe(2);
    // The search behind each probe stopped listening once it ended.
    expect(h.listeners.size).toBe(0);
  });

  it('waits for a slow wallet without a second click when the trigger accepted the first one', async () => {
    // The money-path guard: a CTA that disables itself has taken the click, so
    // a second one would be a second signing request. The popup then gets the
    // rest of the test, and arrives late on its own.
    const h = harness({ appearsAfterClicks: 99, triggerReactsToClick: true });
    const result = clickUntilApprovalPopup(h.trigger, opts(h) as never);
    await jest.advanceTimersByTimeAsync(POPUP_AFTER_CLICK_PROBE_MS * 5);
    h.openLate();
    const res = await result;
    expect({ clicks: res.clicks, page: res.page }).toEqual({ clicks: 1, page: h.page });
  });
});
