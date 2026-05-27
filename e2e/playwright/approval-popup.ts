import type { BrowserContext, Page } from '@playwright/test';

/**
 * Wait for a wallet-extension approval popup to open in the given
 * browser context, identified by a caller-supplied predicate.
 *
 * Event-driven, no polling sleeps. Handles three cases:
 *   - The popup already opened between `knownPages` snapshot and the
 *     call to this function → return it immediately.
 *   - The popup opens on a new page event with the approval URL
 *     already in place → return on the page event.
 *   - The popup opens on a new page event with a transient URL,
 *     then navigates to the approval URL → the predicate retries
 *     after a short URL/element wait.
 *
 * Caller patterns:
 *   - URL-anchored (Unisat / Wizz / Xverse):
 *       isApproval: p => p.url().includes('notification.html#/approval')
 *   - Element-anchored (Leather — has a stable testid on the approval
 *     surface):
 *       isApproval: async p => await p.getByTestId('…approve-button')
 *                                    .isVisible({ timeout: 1_000 })
 *                                    .catch(() => false)
 *
 * Throws if no matching page appears within `timeoutMs` (default 60s).
 */
export async function waitForApprovalPopup(opts: {
  context: BrowserContext;
  knownPages: Set<Page>;
  isApproval: (p: Page) => boolean | Promise<boolean>;
  timeoutMs?: number;
}): Promise<Page> {
  const { context, knownPages, isApproval } = opts;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // Synchronous-only fast-path on already-open pages, so we don't
  // race-await before the event listener attaches.
  for (const p of context.pages()) {
    if (knownPages.has(p)) continue;
    const res = isApproval(p);
    if (res === true) return p;
  }

  return context.waitForEvent('page', {
    timeout: timeoutMs,
    predicate: async (p) => {
      if (knownPages.has(p)) return false;
      try {
        const res = await isApproval(p);
        return !!res;
      } catch {
        return false;
      }
    },
  });
}
