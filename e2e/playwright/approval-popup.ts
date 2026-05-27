import type { BrowserContext, Page } from '@playwright/test';

/**
 * Wait for a wallet-extension approval popup to open in the given
 * browser context, identified by a caller-supplied predicate.
 *
 * Event-driven, no polling sleeps. Three observable surfaces:
 *   1. Pages that already exist at call time → predicate-checked
 *      immediately.
 *   2. Pages that open later via `context.on('page')`.
 *   3. URL/framework navigations on any of the above via
 *      `page.on('framenavigated')` — needed because some wallets open
 *      a chrome-extension page at a transient URL (popup.html bare
 *      route) and only navigate to the approval surface (e.g.
 *      `#/approval`) once their React app finishes mounting.
 *
 * Caller patterns:
 *   - URL-anchored (Unisat / Wizz):
 *       isApproval: p => p.url().includes('notification.html#/approval')
 *   - Element-anchored (Leather — stable testid; Xverse — visible
 *     button by role+name):
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

  return new Promise<Page>((resolve, reject) => {
    let settled = false;

    const finishOk = (p: Page) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(p);
    };
    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const tryMatch = async (p: Page) => {
      if (settled) return;
      try {
        if (await isApproval(p)) finishOk(p);
      } catch { /* keep waiting */ }
    };

    const onPage = (p: Page) => {
      if (knownPages.has(p)) return;
      void tryMatch(p);
      // Re-check whenever this page navigates — the wallet may open
      // on a transient URL and only land on the approval surface after
      // a couple of redirects / React-router transitions.
      p.on('framenavigated', () => void tryMatch(p));
    };

    const timer = setTimeout(
      () => finishErr(new Error(`approval popup did not appear within ${timeoutMs}ms`)),
      timeoutMs,
    );

    const cleanup = () => {
      clearTimeout(timer);
      context.off('page', onPage);
    };

    // Initial pass: existing pages + listener for new ones.
    for (const p of context.pages()) onPage(p);
    context.on('page', onPage);
  });
}
