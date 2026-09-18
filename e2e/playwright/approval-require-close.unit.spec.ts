import { clickApprovalAndRequireClose } from './approval-popup';

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
      clickApprovalAndRequireClose(button, { isClosed: () => closed }, { closeTimeoutMs: 2_000 }),
    ).resolves.toBeUndefined();
    expect(button.clicks).toBe(1);
  });

  it('names the swallowed click when the button survives the click', async () => {
    const button = control({ visible: true, enabled: true });
    await expect(
      clickApprovalAndRequireClose(button, { isClosed: () => false }, { closeTimeoutMs: 50, label: 'OKX sign' }),
    ).rejects.toThrow(/OKX sign.*swallowed-click signature.*visible=true enabled=true/s);
  });

  it('names the wallet instead when the button reacted but nothing finished', async () => {
    const button = control({ visible: true, enabled: false });
    await expect(
      clickApprovalAndRequireClose(button, { isClosed: () => false }, { closeTimeoutMs: 50 }),
    ).rejects.toThrow(/the click registered and the wallet did not finish.*enabled=false/s);
  });

  it('never sends a second click, whatever the popup does', async () => {
    // A signing popup: a second click is a second signature request. The
    // diagnostic exists to identify a swallowed click, not to repeat one.
    const button = control({ visible: true, enabled: true });
    await clickApprovalAndRequireClose(button, { isClosed: () => false }, { closeTimeoutMs: 50 }).catch(
      () => undefined,
    );
    expect(button.clicks).toBe(1);
  });
});
