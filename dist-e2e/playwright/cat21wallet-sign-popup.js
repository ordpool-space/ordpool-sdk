"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.approveCat21WalletConnectPopup = approveCat21WalletConnectPopup;
exports.approveCat21WalletSignPopup = approveCat21WalletSignPopup;
const test_1 = require("@playwright/test");
const approval_popup_1 = require("./approval-popup");
/**
 * Wait for the Cat21 Wallet's getAddresses approval popup to open
 * in `context`, then click the approve button.
 *
 * Identified by the `get-addresses-approve-button` testid on a
 * chrome-extension:// page (see the wallet's OnboardingSelectors
 * bundle). Every cat21wallet spec that connects to the dapp goes
 * through this surface.
 */
async function approveCat21WalletConnectPopup(context, knownPages) {
    const approval = await (0, approval_popup_1.waitForApprovalPopup)({
        context,
        knownPages,
        isApproval: async (p) => {
            if (!p.url().startsWith('chrome-extension://'))
                return false;
            await p
                .getByTestId('get-addresses-approve-button')
                .waitFor({ state: 'visible' });
            return true;
        },
    });
    // The wallet closes the popup the moment it accepts the approval, so the
    // close is the proof the click landed.
    await (0, approval_popup_1.clickApprovalAndRequireClose)(approval.getByTestId('get-addresses-approve-button'), approval, {
        label: 'Cat21 Wallet connect popup',
    });
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
async function approveCat21WalletSignPopup(args) {
    const { context, knownPages, screenshot, expectedSignAtIndex } = args;
    const requireSignPsbtUrl = expectedSignAtIndex !== undefined;
    const approval = await (0, approval_popup_1.waitForApprovalPopup)({
        context,
        knownPages,
        isApproval: async (p) => {
            if (!p.url().startsWith('chrome-extension://'))
                return false;
            if (requireSignPsbtUrl && !p.url().includes('sign-psbt'))
                return false;
            await p
                .getByRole('button', { name: /^(confirm|sign|approve)$/i })
                .first()
                .waitFor({ state: 'visible' });
            return true;
        },
    });
    if (screenshot)
        await screenshot(approval);
    if (expectedSignAtIndex !== undefined) {
        const url = approval.url();
        (0, test_1.expect)(url, 'sign popup URL must encode the sign-psbt route').toContain('sign-psbt');
        const expected = Array.isArray(expectedSignAtIndex) ? expectedSignAtIndex : [expectedSignAtIndex];
        for (const idx of expected) {
            (0, test_1.expect)(url, `sign popup URL must carry signAtIndex=${idx}`).toContain(`signAtIndex=${idx}`);
        }
        await (0, test_1.expect)(approval.getByTestId('psbt-signer-card'), 'psbt-signer-card must render in the sign popup').toBeVisible();
    }
    const confirmBtn = approval.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first();
    await (0, test_1.expect)(confirmBtn).toBeVisible();
    await (0, approval_popup_1.clickApprovalAndRequireClose)(confirmBtn, approval, { label: 'Cat21 Wallet sign popup' });
    knownPages.add(approval);
}
//# sourceMappingURL=cat21wallet-sign-popup.js.map