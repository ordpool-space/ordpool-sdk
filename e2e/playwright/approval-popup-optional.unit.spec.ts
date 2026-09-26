/**
 * `waitForOptionalApprovalPopup`: null means "the wallet showed nothing within
 * the window", and only that. Any other failure has to reach the spec, or a
 * broken context reads as a wallet that simply did not ask.
 */

import { ApprovalPopupTimeoutError, waitForApprovalPopup, waitForOptionalApprovalPopup } from './approval-popup';

const noPages = {
  pages: () => [],
  on: () => undefined,
  off: () => undefined,
};

const brokenContext = {
  pages: () => { throw new Error('context disposed'); },
  on: () => undefined,
  off: () => undefined,
};

const live = { title: () => Promise.resolve('approve'), isClosed: () => false };
const withLivePage = { pages: () => [live], on: () => undefined, off: () => undefined };

describe('waitForOptionalApprovalPopup', () => {
  it('resolves null when no popup appears within the window', async () => {
    const page = await waitForOptionalApprovalPopup({
      context: noPages as never,
      knownPages: new Set(),
      isApproval: () => true,
      timeoutMs: 50,
    });
    expect(page).toBeNull();
  });

  it('returns the popup when one appears', async () => {
    const page = await waitForOptionalApprovalPopup({
      context: withLivePage as never,
      knownPages: new Set(),
      isApproval: () => true,
      timeoutMs: 1_000,
    });
    expect(page).toBe(live as never);
  });

  it('rethrows a failure that is not the timeout', async () => {
    await expect(waitForOptionalApprovalPopup({
      context: brokenContext as never,
      knownPages: new Set(),
      isApproval: () => true,
      timeoutMs: 1_000,
    })).rejects.toThrow('context disposed');
  });

  it('waitForApprovalPopup names its timeout with a dedicated error class', async () => {
    const err = await waitForApprovalPopup({
      context: noPages as never,
      knownPages: new Set(),
      isApproval: () => true,
      timeoutMs: 50,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalPopupTimeoutError);
    expect((err as Error).message).toBe('approval popup did not appear within 50ms');
  });
});
