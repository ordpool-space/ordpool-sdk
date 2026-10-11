import type { BrowserContext, Locator, Page } from '@playwright/test';
import type { ClickableControl } from './click-until-effect';
/**
 * `isApproval` anchored on the control the caller is about to use. `url` only
 * narrows; `control` decides. Both waits run under the runner config's
 * per-wait bound (`navigationTimeout` / `actionTimeout`).
 */
export declare function approvalGate(opts: {
    url?: RegExp;
    control: (page: Page) => Locator;
}): (page: Page) => Promise<boolean>;
/** The arguments every popup search takes. */
export interface ApprovalPopupSearch {
    context: BrowserContext;
    knownPages: Set<Page>;
    isApproval: (p: Page) => boolean | Promise<boolean>;
}
/**
 * Wait for a wallet-extension approval popup to open in the given
 * browser context, identified by a caller-supplied predicate.
 *
 * Event-driven, no polling sleeps. Strategy:
 *   - For every chrome-extension page (existing + new via
 *     `context.on('page')`), kick off `isApproval(page)`.
 *   - Each `isApproval` blocks until it observes the approval surface
 *     on that page (via `page.waitForURL` for URL-anchored matches
 *     or `locator.waitFor({state:'visible'})` for testid/role
 *     matches). When ANY page's `isApproval` resolves truthy, that
 *     page wins and the outer promise resolves with it.
 *
 * ANCHOR ON THE CONTROL, not on the URL. `approvalGate` below builds the
 * predicate.
 *
 *     isApproval: approvalGate({
 *       url: /notification\.html#\/approval/,      // optional pre-filter
 *       control: p => p.getByText(/^Connect$/).first(),
 *     })
 *
 * A URL-only predicate is racy: an extension popup's route is a HASH, so it
 * matches the instant the window exists while the app is still booting, and
 * the caller's click then spends its budget on a control that never mounted.
 *
 * `isApproval` may throw (the page closes under it, or a wait inside it gives
 * up). The helper swallows that throw and keeps waiting on the OTHER pages,
 * which is the right behaviour: one page failing the match shouldn't abort
 * the search.
 *
 * The search as a whole is one wait and ends at the per-wait bound
 * (`e2eTimeoutMs`), rejecting with the last reason a page failed the match.
 * The waits inside `isApproval` run under the runner config's per-wait bound.
 */
export declare function waitForApprovalPopup(opts: ApprovalPopupSearch): Promise<Page>;
/** What `raceApprovalPopup` observed first. */
export type ApprovalPopupRace = {
    outcome: 'popup';
    page: Page;
} | {
    outcome: 'no-popup';
};
/** The part of a Playwright `Locator` the no-popup state needs. */
export interface AwaitableState {
    waitFor(options: {
        state: 'visible';
    }): Promise<void>;
}
/**
 * For a popup the wallet MAY show, such as a connect approval that an already
 * connected wallet skips: race "the popup appears" against an app state that
 * exists only when no popup is coming, and say which happened first.
 *
 * `noPopupState` must be EXCLUSIVE to the no-popup path, e.g. the connected
 * wallet's address rendered by the app, which only appears once the connect
 * resolved without asking. A state that also appears while the popup is
 * pending (a spinner, the page shell) wins the race on every run and hides the
 * popup.
 *
 *     const race = await raceApprovalPopup({
 *       context, knownPages, isApproval,
 *       noPopupState: page.getByTestId('wallet-connected-address'),
 *     });
 *     if (race.outcome === 'popup') await approve(race.page);
 *
 * Both sides wait on states under the per-wait bound; nothing here
 * hopes for an absence. The loser is cleaned up: the popup search stops
 * listening, and a later rejection of the losing `waitFor` (when its page
 * closes at teardown) is absorbed here because the race was already decided.
 * A rejection BEFORE either side won (the app page closed, the context broke)
 * rejects the race.
 */
export declare function raceApprovalPopup(opts: ApprovalPopupSearch & {
    noPopupState: AwaitableState;
}): Promise<ApprovalPopupRace>;
/**
 * Close every chrome-extension page in the context except those
 * in `keep`. Defensive — wallets like Xverse, OKX, Phantom, Alby
 * routinely leave a "Connected" dashboard tab open after approval,
 * which then races against the next sign popup (sometimes the
 * wallet reuses that tab; sometimes it opens a fresh one). The
 * `knownPages` filter inside `waitForApprovalPopup` excludes the
 * dashboard, so if the wallet reuses it, the test times out
 * waiting for a sign popup that's actually rendering on the
 * filtered tab.
 *
 * Always call this AFTER the connect/approval result resolved —
 * we never close a popup that's still mid-handshake with the
 * wallet's SW, only ones that already did their job.
 */
export declare function closeLeftoverExtensionPages(context: BrowserContext, keep: Iterable<Page>): Promise<void>;
/**
 * Click Sign in a Wizz/Unisat-family approval popup, once the button is really
 * enabled.
 *
 * The predicate is deliberately LOOSE about the button's text. While the wallet
 * analyses the PSBT the button is disabled and covered by a spinner overlay, so
 * its `textContent` can be a spinner glyph plus whitespace around the word, and
 * a matcher pinned to exactly "Sign" never fires even after the button becomes
 * clickable. That failure is indistinguishable from a button that never enables:
 * both are a timeout. The regex therefore accepts an optional spinner character,
 * while still rejecting neighbouring text like "Signed".
 *
 * Enabledness is read from computed style (`pointerEvents`, `opacity`) rather
 * than a disabled attribute, and the click happens INSIDE the same
 * `page.evaluate` as the check, so the button cannot change state between the
 * two.
 *
 * Pass `onScreenshot` to capture the popup before the wait and after the click;
 * the post-click call is best-effort because the popup auto-closes.
 */
export declare function approveWizzSignPopup(opts: {
    context: BrowserContext;
    knownPages: Set<Page>;
    onScreenshot?: (page: Page, name: string) => Promise<void>;
}): Promise<void>;
export declare function clickApprovalButton(button: {
    click: () => Promise<void>;
}, page: {
    isClosed: () => boolean;
}): Promise<void>;
/**
 * Click an approval button and require the popup to actually close.
 *
 * `clickApprovalButton` alone cannot distinguish "the wallet accepted and
 * dismissed its popup" from "the click never registered", because both look
 * like a click that returned without error. The difference only surfaces much
 * later, as a missing broadcast or a harness wait that times out, by which
 * point the popup is one of several suspects.
 *
 * This closes that gap by naming the outcome at the click site. It does NOT
 * re-click: a second click on a SIGNING popup is a second signature request,
 * and the point here is to learn whether clicks are being swallowed, not to
 * paper over it. The failure message carries what the control looked like
 * afterwards, which is what separates the two hypotheses:
 *
 *   - button still visible and enabled, page still open — the click did not
 *     register (the swallowed-click signature, see E2E_BEST_PRACTICES 7.7)
 *   - button gone or disabled, page still open — the click registered and the
 *     wallet is stuck or slow on its own side
 */
export declare function clickApprovalAndRequireClose(button: {
    click: () => Promise<void>;
    isVisible: () => Promise<boolean>;
    isEnabled: () => Promise<boolean>;
}, page: {
    isClosed: () => boolean;
}, opts?: {
    label?: string;
}): Promise<void>;
/**
 * Click a page control until the wallet's approval popup appears.
 *
 * `waitForApprovalPopup` answers "did a popup show up", and when the answer is
 * no it cannot say whether the wallet failed to wake or the CLICK
 * that should have asked it never registered. Those have opposite fixes, and a
 * swallowed click is the likelier of the two on a control whose enabled state
 * comes from data that settles after first paint — which every funding-gated
 * CTA in this family is, since `scanning` is a real button state fed by an
 * async scan (see E2E_BEST_PRACTICES 7.7).
 *
 * Safe on a money path because it inherits `clickUntilEffect`'s guard: a second
 * click goes out only while the trigger is STILL VISIBLE AND ENABLED, which is
 * the signature of a click that never landed. A CTA that disables itself while
 * it works has accepted the click, so this waits instead, and then fails saying
 * so rather than asking the wallet to sign twice.
 *
 * Returns the popup and the number of clicks it took. Assert `clicks === 1` on
 * a lane you believe is clean and a swallowed click becomes a named failure
 * instead of a test timeout blamed on the wallet.
 *
 * For an SDK-driven approval — the harness calls the orchestrator and the
 * wallet pops up on its own — there is no trigger to re-click, so use
 * `waitForApprovalPopup` directly. This is for a PAGE-driven trigger only.
 */
/**
 * Probe: how long ONE click gets to produce the popup before the trigger is
 * inspected for a swallowed click. Long enough for a cold extension service
 * worker to open its window, short enough to re-click within the test.
 */
export declare const POPUP_AFTER_CLICK_PROBE_MS = 20000;
export declare function clickUntilApprovalPopup(trigger: ClickableControl, opts: ApprovalPopupSearch & {
    maxClicks?: number;
    label?: string;
}): Promise<{
    page: Page;
    clicks: number;
}>;
/**
 * Wait for the extension page that is offering a CONFIRM BUTTON.
 *
 * The alternative, polling every extension page's body text against a list of
 * headings until a deadline, has two defects, and neither is a property of the
 * wallet.
 *
 * It makes the result depend on MACHINE SPEED. Such a poll passed in 5.4
 * seconds on an idle runner and ran out at 120 on a loaded one, with identical
 * code and extension. A test whose verdict moves with CPU contention is a bad
 * test, not an unlucky one.
 *
 * And it couples the spec to the wallet's COPY. Wallets rename headings between
 * releases, so a rename reads as a broken flow.
 *
 * A confirm button is what the caller needs next, so waiting for it removes the
 * gap between "a heading appeared" and "something is clickable", and it is
 * driven by Playwright's own event-based waiting rather than a busy loop. The
 * search covers pages that are ALREADY open as well as ones that appear, which
 * matters for wallets that reuse one notification page across approvals.
 *
 * When nothing matches, the search rejects at the per-wait bound naming the
 * last `getByText` miss. A page that never painted, or a stale page the
 * wallet reuses without re-rendering, both show up there as the same pending
 * wait; the trace's page list separates them.
 */
export declare function waitForApprovalByConfirmButton(opts: {
    context: BrowserContext;
    /** What the confirm control says. Default covers the common wallet verbs. */
    buttonText?: RegExp;
}): Promise<Page>;
/**
 * Resolve to the page currently SHOWING `text`, across pages that are already
 * open and pages that appear while waiting.
 *
 * Extension onboarding hands a step to an unpredictable page: a wallet may
 * continue in the tab you have, or open a fresh one, and which it does varies
 * by version. Polling every page's innerText until a deadline and then
 * continuing on the original page lets a slow machine expire the search before
 * the wallet painted, so the flow carries on against the WRONG page and fails
 * later somewhere unrelated.
 *
 * This waits on Playwright's event-driven text matching instead, so it returns
 * the moment the text appears rather than on the next tick of a timer, and it
 * never yields a page that did not show the text. A step that may not come is
 * raced against the state that means it is not coming (`raceApprovalPopup`),
 * never caught.
 */
export declare function waitForPageShowing(opts: {
    context: BrowserContext;
    text: RegExp;
    /**
     * Selector of the iframe the step renders in, when it is not the page's own
     * document (OKX draws its onboarding steps inside `#ui-ses-iframe`, leaving
     * the page body empty). Omitted, the text is looked for in the page itself.
     */
    frame?: string;
}): Promise<Page>;
/**
 * Probe: how long one confirm click gets to take effect (the popup closes, the
 * caller's `resolved` settles, or the confirm button goes away) before it
 * counts as absorbed and is sent again. Xverse absorbs a dispatch that lands
 * before its handlers attach; long enough for an accepted click to sign and
 * close the popup on a loaded runner.
 */
export declare const CONFIRM_EFFECT_PROBE_MS = 15000;
/** The part of a Playwright `Locator` the confirm button needs. */
export interface ConfirmButton {
    click(options: {
        force: true;
    }): Promise<void>;
    waitFor(options: {
        state: 'hidden';
        timeout: number;
    }): Promise<void>;
}
/** The part of a Playwright `Page` the popup needs. */
export interface ClosablePopup {
    isClosed(): boolean;
    once(event: 'close', listener: () => void): unknown;
    off(event: 'close', listener: () => void): unknown;
}
/**
 * Click a wallet popup's confirm button until the approval took effect: the
 * popup closed, `resolved` (the dapp-side call waiting on the signature)
 * settled, or the button went away. Each click gets `CONFIRM_EFFECT_PROBE_MS`;
 * a click that changed none of the three within it was absorbed and is sent
 * again, up to `maxClicks`. Returns the clicks sent, so a caller can log or
 * assert that one was enough.
 *
 * The click is forced and its own error only logged: the popup closing under
 * the click is the success shape, and the three effects above, not the click's
 * promise, say whether it landed. The caller's await on `resolved` (or on the
 * signed transaction) is what fails when nothing was ever signed.
 */
export declare function clickConfirmUntilClosed(confirm: ConfirmButton, popup: ClosablePopup, opts?: {
    resolved?: Promise<unknown>;
    maxClicks?: number;
    label?: string;
}): Promise<{
    clicks: number;
}>;
//# sourceMappingURL=approval-popup.d.ts.map