/**
 * @test-kind unit
 * Real:   clickApprovalAndRequireClose, clickApprovalButton, e2eTimeoutMs
 * Faked:  the clock (jest fake timers), the button and the popup page, reduced to click/isVisible/isEnabled and
 *         isClosed (shapes: @playwright/test Locator and Page)
 * Proves: one click, a return once the popup closes, and past the global bound a failure naming which side stalled
 */
import { e2eTimeoutMs } from '../e2e-timeout';
import { clickApprovalAndRequireClose } from './approval-popup';

/**
 * Run the close poll past the global bound on fake timers and hand back what
 * the call settled with. The handler is attached before the clock moves, so
 * the rejection is never unhandled.
 */
async function pastTheBound(call: Promise<void>): Promise<unknown> {
  const settled = call.then(() => 'resolved', (e: unknown) => e);
  await jest.advanceTimersByTimeAsync(e2eTimeoutMs() + 1_000);
  return settled;
}

function control(opts: { visible: boolean; enabled: boolean }) {
  return {
    clicks: 0,
    click: async function (this: { clicks: number }) {
      this.clicks++;
    },
    isVisible: async () => opts.visible,
    isEnabled: async () => opts.enabled,
  };
}

describe('clickApprovalAndRequireClose', () => {
  it('returns once the popup closes', async () => {
    const button = control({ visible: false, enabled: false });
    let closed = false;
    setTimeout(() => {
      closed = true;
    }, 20);
    await expect(
      clickApprovalAndRequireClose(button, { isClosed: () => closed }),
    ).resolves.toBeUndefined();
    expect(button.clicks).toBe(1);
  });

  describe('a popup that never closes, on fake timers', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('names the swallowed click when the button survives the click', async () => {
      const button = control({ visible: true, enabled: true });
      const err = await pastTheBound(clickApprovalAndRequireClose(button, { isClosed: () => false }, { label: 'OKX sign' }));
      expect((err as Error).message).toMatch(/^OKX sign: .*did not close within \d+ms.*swallowed-click signature.*visible=true enabled=true/s);
    });

    it('names the wallet instead when the button reacted but nothing finished', async () => {
      const button = control({ visible: true, enabled: false });
      const err = await pastTheBound(clickApprovalAndRequireClose(button, { isClosed: () => false }));
      expect((err as Error).message).toMatch(/the click registered and the wallet did not finish.*enabled=false/s);
    });

    it('stops at the global bound, which the runner config sets', async () => {
      const button = control({ visible: true, enabled: true });
      const err = await pastTheBound(clickApprovalAndRequireClose(button, { isClosed: () => false }));
      expect((err as Error).message).toContain(`did not close within ${process.env.ORDPOOL_E2E_TIMEOUT_MS}ms`);
    });

    it('sends exactly one click, whatever the popup does', async () => {
      // A signing popup: a second click is a second signature request. The
      // diagnostic exists to identify a swallowed click, not to repeat one.
      const button = control({ visible: true, enabled: true });
      await pastTheBound(clickApprovalAndRequireClose(button, { isClosed: () => false }));
      expect(button.clicks).toBe(1);
    });
  });
});
