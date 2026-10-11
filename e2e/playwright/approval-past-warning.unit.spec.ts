/**
 * @test-kind unit
 * Real:   clickApprovalPastWarning, clickApprovalAndRequireClose, clickApprovalButton, e2eTimeoutMs
 * Faked:  the clock (jest fake timers), the popup page (isClosed), the approval button and the warning's
 *         acknowledgement, reduced to the Locator calls the helper makes (shapes: @playwright/test Locator and Page)
 * Proves: a shown warning is acknowledged once and the held approval click then lands; without a warning the
 *         popup's close ends the search and nothing is acknowledged; a popup that never closes fails with the
 *         approval's own diagnosis, warning or not
 */
import { e2eTimeoutMs } from '../e2e-timeout';
import { clickApprovalPastWarning } from './approval-popup';

/**
 * A popup with an approval button and an optional warning over it. The button's
 * click is held while the warning is up, as Playwright holds a click whose
 * target another element covers. `closesOnApproval: false` models a wallet that
 * never finishes.
 */
function popup(opts: { warning: boolean; closesOnApproval: boolean }) {
  let closed = false;
  let warningUp = opts.warning;
  let release: () => void = () => undefined;
  const warningGone = new Promise<void>((r) => (release = r));
  const closeWaiters: Array<(e: Error) => void> = [];
  const close = () => {
    closed = true;
    for (const w of closeWaiters) w(new Error('locator.waitFor: Target page, context or browser has been closed'));
  };
  const state = { approvals: 0, acknowledgements: 0 };
  const button = {
    click: async () => {
      if (warningUp) await warningGone;
      state.approvals++;
      if (opts.closesOnApproval) setTimeout(close, 10);
    },
    isVisible: async () => !closed,
    isEnabled: async () => !closed,
  };
  const acknowledge = {
    waitFor: () =>
      new Promise<void>((resolve, reject) => {
        if (warningUp) {
          setTimeout(resolve, 5);
          return;
        }
        closeWaiters.push(reject);
        // Playwright's own bound on the wait, with the popup still open.
        setTimeout(() => reject(new Error('locator.waitFor: Timeout exceeded.')), e2eTimeoutMs());
      }),
    click: async () => {
      state.acknowledgements++;
      warningUp = false;
      release();
    },
  };
  return { state, button, acknowledge, page: { isClosed: () => closed } };
}

/** Run the helper on fake timers until well past the global bound. */
async function settle(call: Promise<void>): Promise<unknown> {
  const settled = call.then(() => 'resolved', (e: unknown) => e);
  await jest.advanceTimersByTimeAsync(e2eTimeoutMs() * 3);
  return settled;
}

describe('clickApprovalPastWarning', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('acknowledges a shown warning once, then the held approval click lands and the popup closes', async () => {
    const p = popup({ warning: true, closesOnApproval: true });
    const result = await settle(clickApprovalPastWarning(p.button, p.acknowledge, p.page, { label: 'Wizz sign popup' }));
    expect(result).toBe('resolved');
    expect(p.state).toEqual({ approvals: 1, acknowledgements: 1 });
    expect(p.page.isClosed()).toBe(true);
  });

  it('without a warning, the popup closing ends the search and nothing is acknowledged', async () => {
    const p = popup({ warning: false, closesOnApproval: true });
    const result = await settle(clickApprovalPastWarning(p.button, p.acknowledge, p.page, { label: 'Wizz sign popup' }));
    expect(result).toBe('resolved');
    expect(p.state).toEqual({ approvals: 1, acknowledgements: 0 });
  });

  it('without a warning and a popup that never closes, fails with the approval diagnosis, not the warning wait', async () => {
    const p = popup({ warning: false, closesOnApproval: false });
    const err = await settle(clickApprovalPastWarning(p.button, p.acknowledge, p.page, { label: 'Wizz sign popup' }));
    expect((err as Error).message).toMatch(/^Wizz sign popup: clicked the confirm button and the popup did not close within \d+ms/);
  });

  it('a warning search that fails while the popup is still open is rethrown even though the approval landed', async () => {
    const p = popup({ warning: false, closesOnApproval: true });
    const broken = {
      ...p.acknowledge,
      waitFor: () => Promise.reject(new Error('locator.waitFor: strict mode violation')),
    };
    const err = await settle(clickApprovalPastWarning(p.button, broken, p.page, { label: 'Wizz sign popup' }));
    expect((err as Error).message).toBe('locator.waitFor: strict mode violation');
    expect(p.state).toEqual({ approvals: 1, acknowledgements: 0 });
  });

  it('after acknowledging a warning, a popup that never closes still fails with the approval diagnosis', async () => {
    const p = popup({ warning: true, closesOnApproval: false });
    const err = await settle(clickApprovalPastWarning(p.button, p.acknowledge, p.page, { label: 'Wizz sign popup' }));
    expect((err as Error).message).toMatch(/^Wizz sign popup: clicked the confirm button and the popup did not close/);
    expect(p.state).toEqual({ approvals: 1, acknowledgements: 1 });
  });
});
