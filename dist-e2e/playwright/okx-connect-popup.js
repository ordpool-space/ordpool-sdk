"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isOkxConnectApproval = exports.OKX_CONNECT_URL = void 0;
exports.waitForOkxConnectApproval = waitForOkxConnectApproval;
exports.approveOkxConnectPopup = approveOkxConnectPopup;
const approval_popup_1 = require("./approval-popup");
/**
 * The page OKX shows a dapp's connect request on: `notification.html` or
 * `popup.html`, hash route `/connect` (its UI's route constant), with the
 * request after it (`#/connect/<id>`). `/connect-site` is a different route
 * and does not match.
 */
exports.OKX_CONNECT_URL = /^chrome-extension:\/\/[^/]+\/(?:notification|popup)\.html(?:\?[^#]*)?#\/connect(?:[/?]|$)/;
/** The button that approves the request, on the connect page. */
const connectButton = (page) => page.getByRole('button', { name: /^connect$/i }).first();
/**
 * `isApproval` for OKX's connect request: the page is on `OKX_CONNECT_URL`
 * (now or after a later navigation) and shows its Connect button. The URL
 * keeps out the sign popup OKX may open during a connect; the button is what
 * the caller clicks.
 */
exports.isOkxConnectApproval = (0, approval_popup_1.approvalGate)({ url: exports.OKX_CONNECT_URL, control: connectButton });
/**
 * Find OKX's connect request on any page of the context, the ones open before
 * the request included.
 *
 * OKX 4.1.0 reuses its open popup window: `showPopup` focuses the window it
 * already has (`this.popupId`) and opens a new one only when there is none, so
 * the request can arrive by navigation inside a page that existed before the
 * dapp asked. A `knownPages` filter of the pages open at that moment excludes
 * exactly that page, so this search has none; the URL decides instead.
 */
function waitForOkxConnectApproval(opts) {
    return (0, approval_popup_1.waitForApprovalPopup)({ context: opts.context, knownPages: new Set(), isApproval: exports.isOkxConnectApproval });
}
/**
 * Approve OKX's connect request wherever it shows, and require the page to
 * close: OKX closes it the moment it accepts, so the close proves the click
 * landed. Returns the page it approved on.
 */
async function approveOkxConnectPopup(opts) {
    const approval = await waitForOkxConnectApproval(opts);
    await (0, approval_popup_1.clickApprovalAndRequireClose)(connectButton(approval), approval, { label: 'OKX connect popup' });
    return approval;
}
//# sourceMappingURL=okx-connect-popup.js.map