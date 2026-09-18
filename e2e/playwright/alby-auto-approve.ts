import { BrowserContext, Page } from '@playwright/test';

/**
 * Auto-approve every Alby extension popup the context spawns (the
 * `alby.enable()` permission prompt and, on the SW-bypass specs, any
 * stray confirm surface).
 *
 * Two Alby quirks make a naive visible-then-click flaky, and both are
 * handled with STATE waits, not timeouts:
 *   - On regtest Alby fires a balance fetch that fails and shows an
 *     error toast occluding clicks for a few seconds. `click({ trial:
 *     true })` performs the full actionability check (visible, stable,
 *     enabled, RECEIVES EVENTS) without clicking, so it resolves the
 *     moment the toast stops intercepting the pointer.
 *   - Alby hydrates its React handlers after first paint; a click that
 *     lands pre-hydration is silently absorbed. Actionability cannot
 *     see handler attachment, so the click retries until the popup
 *     closes — the success signal of an accepted approval.
 */
export interface AlbyAutoApproveHandle {
  /** How many popups this listener actually clicked through. */
  approved: () => number;
  /** Every extension page it considered, with the first line it was showing. */
  seen: () => string[];
}

export function installAlbyAutoApprove(
  context: BrowserContext,
  opts: { labels?: RegExp } = {},
): AlbyAutoApproveHandle {
  const labels = opts.labels ?? /^(connect|allow|confirm|approve|sign)$/i;
  let approved = 0;
  const seen: string[] = [];

  const handle = async (popup: Page) => {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 });
      if (!popup.url().startsWith('chrome-extension://')) return;
      const first = await popup.locator('body').innerText().catch(() => '<unreadable>');
      seen.push(`${popup.url().slice(0, 60)} => ${first.trim().split('\n')[0]?.slice(0, 60) || '<empty>'}`);
      const btn = popup.locator('button', { hasText: labels }).first();
      await btn.waitFor({ state: 'visible', timeout: 15_000 });
      await btn.click({ trial: true, timeout: 15_000 });
      for (let attempt = 0; attempt < 8 && !popup.isClosed(); attempt++) {
        await btn.click({ timeout: 2_000 }).catch(() => undefined);
        await popup.waitForEvent('close', { timeout: 1_500 }).catch(() => undefined);
      }
      approved += 1;
    } catch {
      // Best-effort by design, but no longer SILENT: a popup this listener
      // could not approve is recorded in `seen` without an approval, which is
      // what lets a caller say "a permission popup appeared and was never
      // clicked" instead of timing out with nothing to show.
    }
  };

  context.on('page', (p) => void handle(p));
  // Alby may reuse an extension page that is ALREADY open rather than opening a
  // new one, and a listener on 'page' alone never sees that. Same shape that
  // made the okx sign-message wait miss its popup.
  for (const p of context.pages()) void handle(p);

  return { approved: () => approved, seen: () => [...seen] };
}
