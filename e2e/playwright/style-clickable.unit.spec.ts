/**
 * @test-kind unit
 * Real:   waitForStyleClickable, CLICKABLE_MIN_OPACITY, e2eTimeoutMs
 * Faked:  the clock (jest fake timers) and the control, reduced to evaluate() answering a sequence of computed
 *         styles (shape: @playwright/test Locator.evaluate)
 * Proves: the wait returns on the first read that takes clicks, keeps reading while pointer events are off or the
 *         control is faded, and past the global bound fails naming the last style it read
 */
import { e2eTimeoutMs } from '../e2e-timeout';
import { CLICKABLE_MIN_OPACITY, PointerStyle, waitForStyleClickable } from './approval-popup';

/** A control whose computed style walks through `styles`, then stays on the last one. */
function control(styles: PointerStyle[]) {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    evaluate: async () => styles[Math.min(reads++, styles.length - 1)],
  };
}

describe('waitForStyleClickable', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('returns on the first read when the control already takes clicks', async () => {
    const c = control([{ pointerEvents: 'auto', opacity: 1 }]);
    await expect(waitForStyleClickable(c, { label: 'Sign' })).resolves.toBeUndefined();
    expect(c.reads).toBe(1);
  });

  it('keeps reading while pointer events are off, then returns', async () => {
    const c = control([
      { pointerEvents: 'none', opacity: 1 },
      { pointerEvents: 'none', opacity: 1 },
      { pointerEvents: 'auto', opacity: 1 },
    ]);
    const done = waitForStyleClickable(c, { label: 'Sign' });
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBeUndefined();
    expect(c.reads).toBe(3);
  });

  it('keeps reading while the control is faded below the threshold, then returns at the threshold', async () => {
    const c = control([
      { pointerEvents: 'auto', opacity: 0.65 },
      { pointerEvents: 'auto', opacity: CLICKABLE_MIN_OPACITY },
    ]);
    const done = waitForStyleClickable(c, { label: 'Sign' });
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBeUndefined();
    expect(c.reads).toBe(2);
  });

  it('fails past the global bound, naming the label and the last style read', async () => {
    const c = control([{ pointerEvents: 'none', opacity: 0.65 }]);
    const settled = waitForStyleClickable(c, { label: 'Wizz sign popup: the Sign button' }).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await jest.advanceTimersByTimeAsync(e2eTimeoutMs() + 1_000);
    const err = await settled;
    expect((err as Error).message).toBe(
      `Wizz sign popup: the Sign button never became clickable within ${e2eTimeoutMs()}ms (pointerEvents=none opacity=0.65).`,
    );
  });
});
