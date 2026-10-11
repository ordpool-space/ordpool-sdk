import { expect, type BrowserContext, type Page } from '@playwright/test';

import { clickApprovalAndRequireClose, waitForApprovalPopup } from './approval-popup';
import { waitForControlUnlockingIfAsked } from './leather-unlock';
import { PASSWORD_BY_WALLET } from './wallet-test-vectors';

/**
 * Wait for `control` on a Cat21 Wallet popup, unlocking a popup that booted
 * locked (`waitForControlUnlockingIfAsked`), and say so in the log: each one is
 * an instance of the wallet's boot race, worth counting.
 */
async function showCat21WalletControl(
  page: Page,
  control: Parameters<typeof waitForControlUnlockingIfAsked>[1],
  password: string,
  label: string,
): Promise<void> {
  if (await waitForControlUnlockingIfAsked(page, control, password) === 'unlocked') {
    // eslint-disable-next-line no-console
    console.log(`[${label}] the popup booted locked; unlocked it with the wallet password`);
  }
}

/**
 * Wait for the Cat21 Wallet's getAddresses approval popup to open
 * in `context`, then click the approve button.
 *
 * Identified by the `get-addresses-approve-button` testid on a
 * chrome-extension:// page (see the wallet's OnboardingSelectors
 * bundle). Every cat21wallet spec that connects to the dapp goes
 * through this surface. A popup that booted locked is unlocked with
 * `password` (default: the onboarding password, `PASSWORD_BY_WALLET`).
 */
export async function approveCat21WalletConnectPopup(
  context: BrowserContext,
  knownPages: Set<Page>,
  opts: { password?: string } = {},
): Promise<void> {
  const password = opts.password ?? PASSWORD_BY_WALLET.cat21wallet;
  const approval = await waitForApprovalPopup({
    context,
    knownPages,
    isApproval: async p => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await showCat21WalletControl(p, p.getByTestId('get-addresses-approve-button'), password, 'Cat21 Wallet connect popup');
      return true;
    },
  });
  // The wallet closes the popup the moment it accepts the approval, so the
  // close is the proof the click landed.
  await clickApprovalAndRequireClose(approval.getByTestId('get-addresses-approve-button'), approval, {
    label: 'Cat21 Wallet connect popup',
  });
}

interface ApproveCat21WalletSignPopupArgs {
  context: BrowserContext;
  /** Pages already known before the operation that opens the popup. */
  knownPages: Set<Page>;
  /** Optional callback used to capture a screenshot of the approval page. */
  screenshot?: (page: Page) => Promise<void>;
  /**
   * Optional content gate. When provided, the helper asserts that the
   * popup URL contains `sign-psbt` and one `signAtIndex=<n>` param
   * per listed index; the `psbt-signer-card` testid must be visible
   * before the confirm click. Used by the offer + transfer specs to
   * pin WHICH inputs the wallet is about to sign; mint + inscribe
   * (single signing input, no externally-driven index) omit it.
   *
   * Pass an array (e.g. `[0, 1]`) for the transfer flow where cat21-
   * wallet signs both inputs in ONE popup via the signAtIndex-array
   * RPC shape. Pass a single number when only one index is signed.
   */
  expectedSignAtIndex?: number | number[];
  /** Unlocks a popup that booted locked; default: the onboarding password (`PASSWORD_BY_WALLET`). */
  password?: string;
}

/**
 * Wait for the Cat21 Wallet's sign-PSBT popup to open in `context`,
 * optionally verify the URL and DOM content, click the
 * Confirm/Sign/Approve button and require the popup to close.
 *
 * The wallet self-closes its sign-psbt popup the moment the confirm
 * dispatch reaches the SW, so the close is the success signal, and
 * `clickApprovalAndRequireClose` fails at this click when it does not
 * come.
 *
 * After the click the approval page is added to `knownPages` so a
 * subsequent `waitForApprovalPopup` in the same spec doesn't
 * re-match this one.
 */
export async function approveCat21WalletSignPopup(
  args: ApproveCat21WalletSignPopupArgs,
): Promise<void> {
  const { context, knownPages, screenshot, expectedSignAtIndex } = args;
  const password = args.password ?? PASSWORD_BY_WALLET.cat21wallet;
  const requireSignPsbtUrl = expectedSignAtIndex !== undefined;

  const approval = await waitForApprovalPopup({
    context,
    knownPages,
    isApproval: async p => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      if (requireSignPsbtUrl && !p.url().includes('sign-psbt')) return false;
      await showCat21WalletControl(
        p,
        p.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first(),
        password,
        'Cat21 Wallet sign popup',
      );
      return true;
    },
  });

  if (screenshot) await screenshot(approval);

  if (expectedSignAtIndex !== undefined) {
    const url = approval.url();
    expect(url, 'sign popup URL must encode the sign-psbt route').toContain('sign-psbt');
    const expected = Array.isArray(expectedSignAtIndex) ? expectedSignAtIndex : [expectedSignAtIndex];
    for (const idx of expected) {
      expect(url, `sign popup URL must carry signAtIndex=${idx}`).toContain(
        `signAtIndex=${idx}`,
      );
    }
    await expect(
      approval.getByTestId('psbt-signer-card'),
      'psbt-signer-card must render in the sign popup',
    ).toBeVisible();
  }

  const confirmBtn = approval.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first();
  await expect(confirmBtn).toBeVisible();
  await clickApprovalAndRequireClose(confirmBtn, approval, { label: 'Cat21 Wallet sign popup' });
  knownPages.add(approval);
}
