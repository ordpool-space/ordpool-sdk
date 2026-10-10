import type { Page } from '@playwright/test';
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
export declare function dismissOkxAssetTransferPromo(approval: Page): Promise<void>;
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
export declare function waitForOkxSignHeadingToClear(approval: Page, isDone?: () => boolean): Promise<void>;
//# sourceMappingURL=okx-sign-popup.d.ts.map