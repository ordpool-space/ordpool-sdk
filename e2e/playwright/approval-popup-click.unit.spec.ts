import { clickApprovalButton } from './approval-popup';

const closedErr = () => new Error('locator.click: Target page, context or browser has been closed');

describe('clickApprovalButton', () => {
  it('returns normally when the click succeeds', async () => {
    let clicked = false;
    await clickApprovalButton(
      { click: async () => { clicked = true; } },
      { isClosed: () => false },
    );
    expect(clicked).toBe(true);
  });

  it('tolerates the page closing when the page is genuinely gone', async () => {
    // What an ACCEPTED approval looks like: the wallet closed its own popup.
    await expect(clickApprovalButton(
      { click: async () => { throw closedErr(); } },
      { isClosed: () => true },
    )).resolves.toBeUndefined();
  });

  it('rethrows a target-closed error when the page is still OPEN', async () => {
    // Then something else closed a different target and the click really did
    // fail; swallowing it here would hide a real defect.
    await expect(clickApprovalButton(
      { click: async () => { throw closedErr(); } },
      { isClosed: () => false },
    )).rejects.toThrow(/has been closed/);
  });

  it('rethrows any OTHER error even on a closed page', async () => {
    await expect(clickApprovalButton(
      { click: async () => { throw new Error('element is not enabled'); } },
      { isClosed: () => true },
    )).rejects.toThrow(/not enabled/);
  });
});
