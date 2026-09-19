import { clickUntilApprovalPopup } from './approval-popup';

/** A context whose `page` event fires only after `appearsAfterClicks` clicks. */
function harness(opts: { appearsAfterClicks: number; triggerReactsToClick?: boolean }) {
  const state = { clicks: 0 };
  const page = { title: async () => 'popup', isClosed: () => false } as never;
  const listeners: ((p: unknown) => void)[] = [];

  const context = {
    on: (_e: string, cb: (p: unknown) => void) => listeners.push(cb),
    off: () => undefined,
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

  return { state, context, trigger, page };
}

const opts = (h: ReturnType<typeof harness>) => ({
  context: h.context,
  knownPages: new Set<never>(),
  isApproval: () => true,
  settleMs: 60,
  label: 'mint-cta',
});

describe('clickUntilApprovalPopup', () => {
  it('sends one click when the wallet pops up', async () => {
    const h = harness({ appearsAfterClicks: 1 });
    const res = await clickUntilApprovalPopup(h.trigger, opts(h) as never);
    expect({ clicks: res.clicks, page: res.page }).toEqual({ clicks: 1, page: h.page });
  });

  it('re-clicks a trigger that never reacted: the swallowed click, not a sleeping wallet', async () => {
    const h = harness({ appearsAfterClicks: 2 });
    const res = await clickUntilApprovalPopup(h.trigger, opts(h) as never);
    expect(res.clicks).toBe(2);
  });

  it('does NOT ask the wallet twice when the trigger accepted the first click', async () => {
    // The money-path guard: a CTA that disables itself has taken the click, so
    // a second one would be a second signing request.
    const h = harness({ appearsAfterClicks: 99, triggerReactsToClick: true });
    await expect(clickUntilApprovalPopup(h.trigger, opts(h) as never)).rejects.toThrow(
      /reacted to the click/,
    );
    expect(h.state.clicks).toBe(1);
  });
});
