"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.approveCat21WalletConnectPopup = approveCat21WalletConnectPopup;
exports.approveCat21WalletSignPopup = approveCat21WalletSignPopup;
const test_1 = require("@playwright/test");
const approval_popup_1 = require("./approval-popup");
const leather_unlock_1 = require("./leather-unlock");
const wallet_test_vectors_1 = require("./wallet-test-vectors");
/**
 * Wait for `control` on a Cat21 Wallet popup, unlocking a popup that booted
 * locked (`waitForControlUnlockingIfAsked`), and say so in the log: each one is
 * an instance of the wallet's boot race, worth counting.
 */
async function showCat21WalletControl(page, control, password, label) {
    if (await (0, leather_unlock_1.waitForControlUnlockingIfAsked)(page, control, password) === 'unlocked') {
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
async function approveCat21WalletConnectPopup(context, knownPages, opts = {}) {
    const password = opts.password ?? wallet_test_vectors_1.PASSWORD_BY_WALLET.cat21wallet;
    const approval = await (0, approval_popup_1.waitForApprovalPopup)({
        context,
        knownPages,
        isApproval: async (p) => {
            if (!p.url().startsWith('chrome-extension://'))
                return false;
            await showCat21WalletControl(p, p.getByTestId('get-addresses-approve-button'), password, 'Cat21 Wallet connect popup');
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
    const password = args.password ?? wallet_test_vectors_1.PASSWORD_BY_WALLET.cat21wallet;
    const requireSignPsbtUrl = expectedSignAtIndex !== undefined;
    const approval = await (0, approval_popup_1.waitForApprovalPopup)({
        context,
        knownPages,
        isApproval: async (p) => {
            if (!p.url().startsWith('chrome-extension://'))
                return false;
            if (requireSignPsbtUrl && !p.url().includes('sign-psbt'))
                return false;
            await showCat21WalletControl(p, p.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first(), password, 'Cat21 Wallet sign popup');
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