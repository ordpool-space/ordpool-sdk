import type { Page } from '@playwright/test';
import { isVisibleWithin } from './is-visible-within';

/**
 * Probe: how long OKX's "Asset transfer pending" promo, and then its close
 * button, get to render over a sign popup. OKX layers the promo on some opens
 * and not others, so absence is the common answer; long enough for the modal
 * to mount after the popup's own render.
 */
const OKX_PROMO_PROBE_MS = 2_000;

/**
 * Probe: how long the promo gets to go away after its close button was
 * clicked. A click OKX ignores leaves it up; the caller's Confirm click then
 * fails at the overlay, naming it, which is the louder place to fail.
 */
const OKX_PROMO_HIDE_PROBE_MS = 10_000;

/**
 * Dismiss the "Asset transfer pending" promo OKX may layer over its sign
 * popup. While it is up, the Confirm button underneath is covered and
 * disabled (CI 26830193081). Dismissed via the modal's close icon, which
 * carries no stable testid, so the selector is the first icon button or an
 * element labelled close.
 *
 * Best effort by design: whether the promo appears is OKX's choice per open,
 * and the Confirm click that follows is what proves the popup is usable.
 */
export async function dismissOkxAssetTransferPromo(approval: Page): Promise<void> {
  const promo = approval.getByText('Asset transfer pending');
  if (!(await isVisibleWithin(promo, OKX_PROMO_PROBE_MS))) return;
  const closeBtn = approval.locator('button:has(svg), [aria-label="close" i], [aria-label="Close" i]').first();
  if (await isVisibleWithin(closeBtn, OKX_PROMO_PROBE_MS)) {
    await closeBtn.click({ force: true }).catch(() => undefined);
  }
  await promo.waitFor({ state: 'hidden', timeout: OKX_PROMO_HIDE_PROBE_MS }).catch(() => undefined);
}

/**
 * Probe: how long the confirmed request's heading gets to clear from an OKX
 * sign popup that stays open. OKX may reuse the same page for the NEXT request
 * at once (a commit followed by its reveal), so a heading that never clears is
 * an expected answer; long enough for a single sign to finish on a loaded
 * runner.
 */
const OKX_SIGN_HEADING_CLEAR_PROBE_MS = 30_000;

/**
 * After confirming one OKX signing request, wait for its heading to clear, so
 * a following search finds the NEXT request rather than re-approving this one
 * (OKX reuses pages and exposes no per-request testid). Returns early when the
 * popup closes or `isDone` reports the operation finished.
 *
 * Polled from the Node side (isClosed-guarded innerText), NOT with
 * `page.waitForFunction`: OKX CLOSES the sign popup the instant it finishes a
 * sign, and a page-side waitForFunction installs a polling handle whose
 * disposal races that close. Playwright then throws an uncatchable, empty-stack
 * "Object with guid ... was not bound in the connection" through the
 * connection's error channel, not as the promise's rejection.
 */
export async function waitForOkxSignHeadingToClear(approval: Page, isDone?: () => boolean): Promise<void> {
  const deadline = Date.now() + OKX_SIGN_HEADING_CLEAR_PROBE_MS;
  while (Date.now() < deadline) {
    if (isDone?.()) return;
    if (approval.isClosed()) return; // popup gone => sign done, heading cleared
    const text = await approval.locator('body').innerText().catch(() => '');
    if (approval.isClosed()) return;
    if (!/Signature request|Confirm Trade/i.test(text)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}
