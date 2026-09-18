import { clickUntilEffect } from './click-until-effect';

/** An effect that becomes visible only after `appearsAfterClicks` clicks. */
function harness(opts: {
  appearsAfterClicks: number;
  /** What the control reports once it has reacted to a click. */
  afterClick?: { visible: boolean; enabled: boolean };
}) {
  const state = { clicks: 0 };
  const after = opts.afterClick ?? { visible: true, enabled: true };
  const reacted = () => state.clicks > 0 && !(after.visible && after.enabled);
  return {
    state,
    control: {
      click: async () => {
        state.clicks++;
      },
      isVisible: async () => (reacted() ? after.visible : true),
      isEnabled: async () => (reacted() ? after.enabled : true),
    },
    effect: {
      waitFor: async () => {
        if (state.clicks >= opts.appearsAfterClicks) return;
        throw new Error('locator.waitFor: Timeout exceeded');
      },
    },
  };
}

describe('clickUntilEffect', () => {
  it('sends exactly one click when the effect appears', async () => {
    const h = harness({ appearsAfterClicks: 1 });
    await expect(clickUntilEffect(h.control, h.effect, { settleMs: 1 })).resolves.toEqual({ clicks: 1 });
    expect(h.state.clicks).toBe(1);
  });

  it('re-clicks a control that is still visible and enabled (the swallowed click)', async () => {
    const h = harness({ appearsAfterClicks: 2 });
    await expect(clickUntilEffect(h.control, h.effect, { settleMs: 1 })).resolves.toEqual({ clicks: 2 });
    expect(h.state.clicks).toBe(2);
  });

  it('does NOT re-click a control that went disabled: the click registered', async () => {
    // The money-path case. A CTA that disables itself while it works has
    // accepted the click; a second one would start a second mint or transfer.
    const h = harness({ appearsAfterClicks: 99, afterClick: { visible: true, enabled: false } });
    await expect(clickUntilEffect(h.control, h.effect, { settleMs: 1 })).rejects.toThrow(/Timeout exceeded/);
    expect(h.state.clicks).toBe(1);
  });

  it('does NOT re-click a control that disappeared: the click registered', async () => {
    const h = harness({ appearsAfterClicks: 99, afterClick: { visible: false, enabled: false } });
    await expect(clickUntilEffect(h.control, h.effect, { settleMs: 1 })).rejects.toThrow(/Timeout exceeded/);
    expect(h.state.clicks).toBe(1);
  });

  it('fails after the click cap with the count and the observed state', async () => {
    const h = harness({ appearsAfterClicks: 99 });
    await expect(
      clickUntilEffect(h.control, h.effect, { settleMs: 1, maxClicks: 3, label: 'mint-cta' }),
    ).rejects.toThrow(/mint-cta was clicked 3 time\(s\).*visible=true enabled=true/s);
    expect(h.state.clicks).toBe(3);
  });
});
