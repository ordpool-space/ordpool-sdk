/**
 * The liveness guard in `waitForApprovalPopup`.
 *
 * A CLOSING extension popup still satisfies "the confirm button is visible",
 * because the DOM is alive while the window goes away. Returning that page
 * means the caller's `click()` waits for the element to be visible, enabled AND
 * STABLE, never reaches stable, and fails with "Target page, context or browser
 * has been closed".
 *
 * That branch only runs when a popup happens to be dying, which is exactly the
 * condition a live stack is built to avoid, so nothing in the e2e suite
 * exercises it. Stubbed pages reach it directly.
 */

import { waitForApprovalPopup } from './approval-popup';

type StubPage = {
  title: () => Promise<string>;
  isClosed: () => boolean;
};

/** A context that hands `pages` to the listener as if they had just opened. */
function stubContext(pages: StubPage[]) {
  return {
    pages: () => pages,
    on: (_event: string, _fn: (p: unknown) => void) => undefined,
    off: (_event: string, _fn: (p: unknown) => void) => undefined,
  };
}

const livePage = (name: string): StubPage => ({
  title: () => Promise.resolve(name),
  isClosed: () => false,
});

/** Visible button, but the window is going away: `title()` never resolves. */
const dyingPage = (): StubPage => ({
  title: () => Promise.reject(new Error('Target page, context or browser has been closed')),
  isClosed: () => false,
});

/** Already gone: answers, but reports closed. */
const closedPage = (): StubPage => ({
  title: () => Promise.resolve('stale'),
  isClosed: () => true,
});

describe('waitForApprovalPopup liveness guard', () => {

  const approveAnything = () => true;

  it('returns a live page whose approval predicate passes', async () => {
    const live = livePage('approve me');
    const page = await waitForApprovalPopup({
      context: stubContext([live]) as never,
      knownPages: new Set(),
      isApproval: approveAnything,
    });
    expect(page).toBe(live as never);
  });

  it('SKIPS a dying page and returns the live one behind it', async () => {
    // The defect: without the guard the dying page is returned, because its
    // confirm button is visible, and the caller's click dies on it.
    const live = livePage('the real one');
    const page = await waitForApprovalPopup({
      context: stubContext([dyingPage(), live]) as never,
      knownPages: new Set(),
      isApproval: approveAnything,
    });
    expect(page).toBe(live as never);
  });

  it('SKIPS an already-closed page and returns the live one behind it', async () => {
    const live = livePage('the real one');
    const page = await waitForApprovalPopup({
      context: stubContext([closedPage(), live]) as never,
      knownPages: new Set(),
      isApproval: approveAnything,
    });
    expect(page).toBe(live as never);
  });

  it('waits past a dying page for a live one that opens later, rather than returning the dying one', async () => {
    // Without a live page there is nothing to return, and the search keeps
    // waiting under the test timeout; with one arriving later, that one wins.
    const listeners: ((p: unknown) => void)[] = [];
    const late = livePage('opens after the dying one');
    const context = {
      pages: () => [dyingPage()],
      on: (_event: string, fn: (p: unknown) => void) => { listeners.push(fn); },
      off: () => undefined,
    };
    const found = waitForApprovalPopup({
      context: context as never,
      knownPages: new Set(),
      isApproval: approveAnything,
    });
    listeners.forEach((fn) => fn(late));
    expect(await found).toBe(late as never);
  });
});
