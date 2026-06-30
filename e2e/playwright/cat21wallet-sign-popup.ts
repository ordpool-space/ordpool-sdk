import { expect, type BrowserContext, type Page } from '@playwright/test';

import { waitForApprovalPopup } from './approval-popup';

/**
 * Wait for the Cat21 Wallet's getAddresses approval popup to open
 * in `context`, then click the approve button.
 *
 * Identified by the `get-addresses-approve-button` testid on a
 * chrome-extension:// page (see the wallet's OnboardingSelectors
 * bundle). Every cat21wallet spec that connects to the dapp goes
 * through this surface.
 */
export async function approveCat21WalletConnectPopup(
  context: BrowserContext,
  knownPages: Set<Page>,
): Promise<void> {
  const approval = await waitForApprovalPopup({
    context,
    knownPages,
    isApproval: async p => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p
        .getByTestId('get-addresses-approve-button')
        .waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    },
  });
  await approval.getByTestId('get-addresses-approve-button').click();
}

interface ApproveCat21WalletSignPopupArgs {
  context: BrowserContext;
  /** Pages already known before the operation that opens the popup. */
  knownPages: Set<Page>;
  /** Optional callback used to capture a screenshot of the approval page. */
  screenshot?: (page: Page) => Promise<void>;
  /**
   * Optional content gate. When provided, the helper asserts that the
   * popup URL contains both `sign-psbt` and `signAtIndex=<value>` and
   * that the `psbt-signer-card` testid is visible before clicking
   * confirm. Used by the offer + transfer specs to pin WHICH input
   * the wallet is about to sign; mint + inscribe (single signing
   * input, no externally-driven index) omit it.
   */
  expectedSignAtIndex?: number;
}

/**
 * Wait for the Cat21 Wallet's sign-PSBT popup to open in `context`,
 * optionally verify the URL and DOM content, and click the
 * Confirm/Sign/Approve button.
 *
 * `{ noWaitAfter: true }` on the click — the wallet self-closes its
 * sign-psbt popup the moment the confirm dispatch reaches the SW.
 * Playwright's default click awaits post-click stability, and that
 * race surfaces as "Target page, context or browser has been closed"
 * when the popup tears down mid-click. The close IS the success
 * signal here.
 *
 * After the click the approval page is added to `knownPages` so a
 * subsequent `waitForApprovalPopup` in the same spec doesn't
 * re-match this one.
 */
export async function approveCat21WalletSignPopup(
  args: ApproveCat21WalletSignPopupArgs,
): Promise<void> {
  const { context, knownPages, screenshot, expectedSignAtIndex } = args;
  const requireSignPsbtUrl = expectedSignAtIndex !== undefined;

  const approval = await waitForApprovalPopup({
    context,
    knownPages,
    timeoutMs: 90_000,
    isApproval: async p => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      if (requireSignPsbtUrl && !p.url().includes('sign-psbt')) return false;
      await p
        .getByRole('button', { name: /^(confirm|sign|approve)$/i })
        .first()
        .waitFor({ state: 'visible', timeout: 90_000 });
      return true;
    },
  });

  if (screenshot) await screenshot(approval);

  if (expectedSignAtIndex !== undefined) {
    const url = approval.url();
    expect(url, 'sign popup URL must encode the sign-psbt route').toContain('sign-psbt');
    expect(url, `sign popup URL must carry signAtIndex=${expectedSignAtIndex}`).toContain(
      `signAtIndex=${expectedSignAtIndex}`,
    );
    await expect(
      approval.getByTestId('psbt-signer-card'),
      'psbt-signer-card must render in the sign popup',
    ).toBeVisible({ timeout: 15_000 });
  }

  const confirmBtn = approval.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first();
  await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
  await confirmBtn.click({ noWaitAfter: true });
  knownPages.add(approval);
}
