/**
 * @test-kind unit
 * Real:   clickConfirmUntilClosed
 * Faked:  the clock (jest fake timers), the confirm button (click/waitFor) and the popup page (isClosed/once/off),
 *         reduced to the members the helper calls (shapes: @playwright/test Locator and Page)
 * Proves: a click is re-sent only when none of close, signature or button-gone followed within the probe,
 *         and the close listener is removed once a click took effect
 */
import { CONFIRM_EFFECT_PROBE_MS, clickConfirmUntilClosed } from './approval-popup';

/** A popup that closes on the `closesOnClick`-th click; Infinity means never. */
function harness(opts: { closesOnClick?: number; hidesOnClick?: number } = {}) {
  const closesOn = opts.closesOnClick ?? Infinity;
  const hidesOn = opts.hidesOnClick ?? Infinity;
  const state = { clicks: 0, closed: false, listeners: new Set<() => void>() };
  let hide: () => void = () => undefined;
  const popup = {
    isClosed: () => state.closed,
    once: (_e: 'close', fn: () => void) => { state.listeners.add(fn); },
    off: (_e: 'close', fn: () => void) => { state.listeners.delete(fn); },
  };
  const confirm = {
    click: async () => {
      state.clicks++;
      if (state.clicks >= closesOn) {
        // The wallet closes its popup a moment after accepting the click.
        setTimeout(() => {
          state.closed = true;
          [...state.listeners].forEach((fn) => fn());
        }, 100);
      }
      if (state.clicks >= hidesOn) setTimeout(() => hide(), 100);
    },
    waitFor: ({ timeout }: { state: 'hidden'; timeout: number }) => new Promise<void>((resolve, reject) => {
      hide = resolve;
      setTimeout(() => reject(new Error(`locator.waitFor: Timeout ${timeout}ms exceeded`)), timeout);
    }),
  };
  return { state, popup, confirm };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('clickConfirmUntilClosed', () => {
  it('sends one click when the popup closes after it', async () => {
    const h = harness({ closesOnClick: 1 });
    const result = clickConfirmUntilClosed(h.confirm, h.popup);
    await jest.advanceTimersByTimeAsync(CONFIRM_EFFECT_PROBE_MS);
    expect(await result).toEqual({ clicks: 1 });
    expect(h.state.listeners.size).toBe(0);
  });

  it('re-sends a click that changed nothing within the probe', async () => {
    const h = harness({ closesOnClick: 2 });
    const result = clickConfirmUntilClosed(h.confirm, h.popup);
    await jest.advanceTimersByTimeAsync(CONFIRM_EFFECT_PROBE_MS - 1);
    expect(h.state.clicks).toBe(1);
    await jest.advanceTimersByTimeAsync(CONFIRM_EFFECT_PROBE_MS);
    expect(await result).toEqual({ clicks: 2 });
  });

  it('stops after one click when the signature arrives, even though the popup stays open', async () => {
    const h = harness();
    let sign: () => void = () => undefined;
    const signed = new Promise<void>((r) => { sign = r; });
    const result = clickConfirmUntilClosed(h.confirm, h.popup, { resolved: signed });
    let returnedAt: number | undefined;
    void result.then(() => { returnedAt = Date.now(); });
    await jest.advanceTimersByTimeAsync(500);
    const signedAt = Date.now();
    sign();
    await jest.advanceTimersByTimeAsync(CONFIRM_EFFECT_PROBE_MS * 3);
    expect(await result).toEqual({ clicks: 1 });
    // It returns on the signature, not when the probe runs out.
    expect(returnedAt).toBe(signedAt);
  });

  it('stops after one click when the confirm button goes away', async () => {
    const h = harness({ hidesOnClick: 1 });
    const result = clickConfirmUntilClosed(h.confirm, h.popup);
    await jest.advanceTimersByTimeAsync(CONFIRM_EFFECT_PROBE_MS * 3);
    expect(await result).toEqual({ clicks: 1 });
  });

  it('gives up after maxClicks and reports every click it sent', async () => {
    const h = harness();
    const result = clickConfirmUntilClosed(h.confirm, h.popup, { maxClicks: 3 });
    await jest.advanceTimersByTimeAsync(CONFIRM_EFFECT_PROBE_MS * 4);
    expect(await result).toEqual({ clicks: 3 });
  });
});
