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

describe('clickApprovalButton: the close races the click rejection', () => {
  it('accepts a target-closed error whose close becomes observable a moment later', async () => {
    let closed = false;
    // The wallet dismisses its popup; Playwright rejects the click first and
    // the page reports closed only afterwards. Reading isClosed() once here
    // would rethrow on the SUCCESS path.
    setTimeout(() => { closed = true; }, 300);

    await expect(
      clickApprovalButton(
        { click: () => Promise.reject(new Error('locator.click: Target page, context or browser has been closed')) },
        { isClosed: () => closed },
      ),
    ).resolves.toBeUndefined();
  });

  it('still throws when the page never closes, so a swallowed click is not hidden', async () => {
    await expect(
      clickApprovalButton(
        { click: () => Promise.reject(new Error('locator.click: Target page, context or browser has been closed')) },
        { isClosed: () => false },
      ),
    ).rejects.toThrow(/has been closed/);
  });
});
