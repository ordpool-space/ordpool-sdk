import type { BrowserContext, Locator, Page } from '@playwright/test';
import { e2eTimeoutMs } from '../e2e-timeout';
import type { ClickableControl } from './click-until-effect';
import { clickUntilEffectWithProbe } from './click-until-effect-core';

/**
 * `isApproval` anchored on the control the caller is about to use. `url` only
 * narrows; `control` decides. Both waits run under the runner config's
 * timeouts (`navigationTimeout` / `actionTimeout`, unset meaning the test
 * timeout).
 */
export function approvalGate(opts: {
  url?: RegExp;
  control: (page: Page) => Locator;
}): (page: Page) => Promise<boolean> {
  return async (page: Page): Promise<boolean> => {
    if (opts.url) await page.waitForURL(opts.url);
    await opts.control(page).waitFor({ state: 'visible' });
    return true;
  };
}

/** The arguments every popup search takes. */
export interface ApprovalPopupSearch {
  context: BrowserContext;
  knownPages: Set<Page>;
  isApproval: (p: Page) => boolean | Promise<boolean>;
}

/**
 * A running popup search: `found` resolves with the first live page whose
 * `isApproval` passed; `cancel()` stops listening for new pages. `found` never
 * rejects on its own; a bound, when one applies, is the caller's.
 */
interface RunningSearch {
  found: Promise<Page>;
  cancel: () => void;
}

function startApprovalPopupSearch(opts: ApprovalPopupSearch): RunningSearch {
  const { context, knownPages, isApproval } = opts;
  let settled = false;
  let resolveFound: (p: Page) => void = () => undefined;
  let rejectFound: (e: unknown) => void = () => undefined;
  const found = new Promise<Page>((resolve, reject) => {
    resolveFound = resolve;
    rejectFound = reject;
  });

  const tryPage = async (p: Page) => {
    if (settled || knownPages.has(p)) return;
    try {
      const res = await isApproval(p);
      if (res !== true) return;

      // A CLOSING popup still satisfies "the confirm button is visible":
      // the DOM is alive while the window goes away. Handing that page back
      // means the caller's `click()` waits for the element to be visible,
      // enabled AND STABLE, never gets stable because the page is dying, and
      // fails with "Target page, context or browser has been closed". The
      // observed shape is a fast failure in specs that approve twice in
      // quick succession.
      //
      // So require the page to answer a round-trip before returning it. A
      // page that is going away cannot, and the search continues for the one
      // that is actually live. This is a liveness check rather than a delay:
      // nothing is waited out, the page either responds or it does not.
      await p.title();
      if (p.isClosed()) return;

      if (settled) return;
      settled = true;
      cancel();
      resolveFound(p);
    } catch {
      // isApproval rejected (the page closed, or its own wait gave up), or the
      // liveness probe failed because the page went away. Don't abort the
      // search: another page may still match.
    }
  };

  const onPage = (p: Page) => void tryPage(p);
  const cancel = () => {
    settled = true;
    context.off('page', onPage);
  };

  try {
    context.on('page', onPage);
    for (const p of context.pages()) void tryPage(p);
  } catch (e) {
    // A context that cannot be read (disposed, closed) is not a context
    // without a popup: report it rather than waiting on it.
    cancel();
    rejectFound(e);
  }
  return { found, cancel };
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
 * There is no deadline of its own. The waits inside `isApproval` run under the
 * runner config's timeouts and the search as a whole under the test timeout,
 * whose report names the pending wait.
 */
export async function waitForApprovalPopup(opts: ApprovalPopupSearch): Promise<Page> {
  return startApprovalPopupSearch(opts).found;
}

/** What `raceApprovalPopup` observed first. */
export type ApprovalPopupRace =
  | { outcome: 'popup'; page: Page }
  | { outcome: 'no-popup' };

/** The part of a Playwright `Locator` the no-popup state needs. */
export interface AwaitableState {
  waitFor(options: { state: 'visible' }): Promise<void>;
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
 * Both sides wait on states under the runner config's timeouts; nothing here
 * hopes for an absence. The loser is cleaned up: the popup search stops
 * listening, and a later rejection of the losing `waitFor` (when its page
 * closes at teardown) is absorbed here because the race was already decided.
 * A rejection BEFORE either side won (the app page closed, the context broke)
 * rejects the race.
 */
export async function raceApprovalPopup(
  opts: ApprovalPopupSearch & { noPopupState: AwaitableState },
): Promise<ApprovalPopupRace> {
  const search = startApprovalPopupSearch(opts);
  return new Promise<ApprovalPopupRace>((resolve, reject) => {
    let decided = false;
    const decide = (result: ApprovalPopupRace) => {
      if (decided) return;
      decided = true;
      search.cancel();
      resolve(result);
    };
    const fail = (e: unknown) => {
      if (decided) return;
      decided = true;
      search.cancel();
      reject(e);
    };
    search.found.then((page) => decide({ outcome: 'popup', page }), fail);
    let noPopup: Promise<void>;
    try {
      noPopup = opts.noPopupState.waitFor({ state: 'visible' });
    } catch (e) {
      fail(e);
      return;
    }
    noPopup.then(() => decide({ outcome: 'no-popup' }), fail);
  });
}

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
export async function closeLeftoverExtensionPages(
  context: BrowserContext,
  keep: Iterable<Page>,
): Promise<void> {
  const keepSet = new Set(keep);
  for (const p of context.pages()) {
    if (keepSet.has(p)) continue;
    // OKX (and other wallets) tear their own pages down the instant they
    // auto-approve, so a page enumerated here can already be closing.
    // `p.url()` on a closed page throws "guid not bound" — uncaught, that
    // failed the whole spec during the connect/commit cleanup, before the
    // flow even reached the next sign. Skip closed pages and swallow a page
    // that closes between the isClosed() check and the url() read.
    if (p.isClosed()) continue;
    try {
      if (!p.url().startsWith('chrome-extension://')) continue;
    } catch {
      continue;
    }
    await p.close().catch(() => undefined);
  }
}

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
export async function approveWizzSignPopup(opts: {
  context: BrowserContext;
  knownPages: Set<Page>;
  onScreenshot?: (page: Page, name: string) => Promise<void>;
}): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: opts.context,
    knownPages: opts.knownPages,
    // Anchored on the Sign button; the plain-string NAME form is the one that
    // matches this control, measured rather than inferred.
    isApproval: approvalGate({
      url: /notification\.html#\/approval/,
      control: (p) => p.getByRole('button', { name: 'Sign' }),
    }),
  });
  await opts.onScreenshot?.(approval, 'sign-approval');

  // Describe, read, then click: the popup auto-closes on the click, so a
  // handle read afterwards reaches a closed page.
  const describeSign = () => {
    const isSignButton = (el: Element) => {
      const text = (el.textContent || '').trim();
      // Optional leading spinner glyph; rejects "Signed" and similar.
      return /^\s*[⠀-⣿•●]?\s*Sign\s*$/i.test(text);
    };
    const els = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], div'));
    const candidate = els.find(isSignButton);
    if (!candidate) return null;
    const style = getComputedStyle(candidate);
    if (style.pointerEvents === 'none') return null;
    if (parseFloat(style.opacity) < 0.7) return null;
    return {
      text: candidate.textContent,
      tag: candidate.tagName,
      cls: candidate.className,
      testid: candidate.getAttribute('data-testid'),
      role: candidate.getAttribute('role'),
      parentTag: candidate.parentElement?.tagName ?? null,
      parentCls: candidate.parentElement?.className ?? null,
    };
  };

  const found = await approval.waitForFunction(describeSign, undefined, { polling: 250 });
  // Reported so these gates can be anchored on the real element. Wizz strips
  // data-testid. The six Wizz SIGN gates stay URL-only until a locator is
  // verified against a real run: 94b5e2a anchored them on
  // getByRole('button', { name: /^Sign$/ }) from this line's `text` field and
  // all six specs then failed with "approval popup did not appear". textContent
  // is not the accessible name, so the next attempt must measure the NAME, or
  // use locator('button', { hasText }) which matches on text.
  // One check, not a description: does the anchor the gate above uses still
  // match exactly one control? A future Wizz release that renames the button
  // shows up here as 0 instead of as a gate that waits out the test timeout.
  const anchor = await approval.getByRole('button', { name: 'Sign' }).count().catch(() => -1);
  // eslint-disable-next-line no-console
  console.log(`[wizz:sign-popup] anchor=${anchor} ${JSON.stringify(await found.jsonValue())}`);

  await approval.evaluate(() => {
    const isSignButton = (el: Element) => /^\s*[⠀-⣿•●]?\s*Sign\s*$/i.test((el.textContent || '').trim());
    const els = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], div'));
    els.find(isSignButton)?.click();
  });

  // The popup auto-closes once the wallet processes the click, so this is
  // best-effort by design.
  await opts.onScreenshot?.(approval, 'after-sign-click').catch(() => undefined);
}

/**
 * Click an approval button that DISMISSES ITS OWN PAGE.
 *
 * A wallet closes its approval popup the moment it accepts the click, and
 * Playwright's post-click bookkeeping then runs against a target that no longer
 * exists, throwing "Target page, context or browser has been closed". From the
 * click's own error there is no way to tell that outcome, which is SUCCESS,
 * apart from a click that never landed.
 *
 * So the close is tolerated only when the page is genuinely gone, which is what
 * an accepted approval looks like. This hides nothing: if the click did not
 * land, the wallet never signs, and the spec's own downstream assertion (a
 * broadcast txid, a confirmed transaction, a success panel) fails with a
 * message about the thing that actually matters. Any other error still throws.
 */
/**
 * Probe: how long a target-closed click error waits for the close to become
 * observable. Long enough to cover the gap between the click's rejection and
 * the page's close event, short enough that a click which never landed still
 * fails at the click.
 */
const CLOSE_GRACE_MS = 2_000;

export async function clickApprovalButton(
  button: { click: () => Promise<void> },
  page: { isClosed: () => boolean },
): Promise<void> {
  try {
    await button.click();
  } catch (e) {
    const message = (e as Error).message ?? '';
    const targetGone = /Target (page|closed)|context or browser has been closed|has been closed/i.test(message);
    if (!targetGone) throw e;
    // The close is IN FLIGHT when the click rejects, so `isClosed()` read once
    // can still be false and the success case would rethrow. Give the close a
    // short grace period; anything longer would start hiding a click that
    // never landed, which is what the caller's own close-wait is for.
    const graceDeadline = Date.now() + CLOSE_GRACE_MS;
    while (!page.isClosed() && Date.now() < graceDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (page.isClosed()) return;
    throw e;
  }
}

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
export async function clickApprovalAndRequireClose(
  button: {
    click: () => Promise<void>;
    isVisible: () => Promise<boolean>;
    isEnabled: () => Promise<boolean>;
  },
  page: { isClosed: () => boolean },
  opts: { label?: string } = {},
): Promise<void> {
  const label = opts.label ?? 'approval popup';
  await clickApprovalButton(button, page);

  // A poll on the page handle, not a Playwright wait, so it stops at the
  // global bound (`e2eTimeoutMs`) rather than polling past the test's end.
  const boundMs = e2eTimeoutMs();
  const deadline = Date.now() + boundMs;
  while (!page.isClosed()) {
    if (Date.now() > deadline) {
      const visible = await button.isVisible().catch(() => false);
      const enabled = visible ? await button.isEnabled().catch(() => false) : false;
      const diagnosis =
        visible && enabled
          ? 'the button is STILL VISIBLE AND ENABLED, which is the swallowed-click signature'
          : 'the button is gone or disabled, so the click registered and the wallet did not finish';
      throw new Error(
        `${label}: clicked the confirm button and the popup did not close within ${boundMs}ms. ` +
          `After the click, ${diagnosis} (visible=${visible} enabled=${enabled}).`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

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
export const POPUP_AFTER_CLICK_PROBE_MS = 20_000;

export async function clickUntilApprovalPopup(
  trigger: ClickableControl,
  opts: ApprovalPopupSearch & {
    maxClicks?: number;
    label?: string;
  },
): Promise<{ page: Page; clicks: number }> {
  let found: Page | null = null;
  const effect = {
    // With `timeout`, the probe after a click: no popup within it is an
    // expected answer that sends the trigger back for inspection. Without,
    // the trigger reacted and the popup gets the rest of the test.
    waitFor: async ({ timeout }: { state: 'visible'; timeout?: number }) => {
      const search = startApprovalPopupSearch(opts);
      if (timeout === undefined) {
        found = await search.found;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          search.cancel();
          reject(new Error(`approval popup did not appear within the ${timeout}ms probe`));
        }, timeout);
      });
      try {
        found = await Promise.race([search.found, expired]);
      } finally {
        clearTimeout(timer);
      }
    },
  };

  const { clicks } = await clickUntilEffectWithProbe(trigger, effect, {
    maxClicks: opts.maxClicks ?? 3,
    label: opts.label ?? 'approval trigger',
  }, POPUP_AFTER_CLICK_PROBE_MS);

  if (!found) throw new Error(`${opts.label ?? 'approval trigger'}: popup resolved without a page`);
  return { page: found, clicks };
}

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
 * When nothing matches, the test timeout reports, and its call log names the
 * pending `getByText` wait. A page that never painted, or a stale page the
 * wallet reuses without re-rendering, both show up there as the same pending
 * wait; the trace's page list separates them.
 */
export async function waitForApprovalByConfirmButton(opts: {
  context: BrowserContext;
  /** What the confirm control says. Default covers the common wallet verbs. */
  buttonText?: RegExp;
}): Promise<Page> {
  const buttonText = opts.buttonText ?? /^(Confirm|Sign|Approve)$/;
  return waitForApprovalPopup({
    context: opts.context,
    // Empty on purpose: a wallet may serve this approval from the SAME page
    // it used for an earlier one, and a populated set would skip it.
    knownPages: new Set<Page>(),
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByText(buttonText, { exact: true }).first().waitFor({ state: 'visible' });
      return true;
    },
  });
}

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
export async function waitForPageShowing(opts: {
  context: BrowserContext;
  text: RegExp;
}): Promise<Page> {
  return waitForApprovalPopup({
    context: opts.context,
    knownPages: new Set<Page>(),
    isApproval: async (p) => {
      await p.getByText(opts.text).first().waitFor({ state: 'visible' });
      return true;
    },
  });
}

/**
 * Probe: how long one confirm click gets to take effect (the popup closes, the
 * caller's `resolved` settles, or the confirm button goes away) before it
 * counts as absorbed and is sent again. Xverse absorbs a dispatch that lands
 * before its handlers attach; long enough for an accepted click to sign and
 * close the popup on a loaded runner.
 */
export const CONFIRM_EFFECT_PROBE_MS = 15_000;

/** The part of a Playwright `Locator` the confirm button needs. */
export interface ConfirmButton {
  click(options: { force: true }): Promise<void>;
  waitFor(options: { state: 'hidden'; timeout: number }): Promise<void>;
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
export async function clickConfirmUntilClosed(
  confirm: ConfirmButton,
  popup: ClosablePopup,
  opts: { resolved?: Promise<unknown>; maxClicks?: number; label?: string } = {},
): Promise<{ clicks: number }> {
  const maxClicks = opts.maxClicks ?? 4;
  const label = opts.label ?? 'confirm';
  let settled = false;
  opts.resolved?.then(() => { settled = true; }, () => { settled = true; });

  let clicks = 0;
  while (clicks < maxClicks && !popup.isClosed() && !settled) {
    await confirm.click({ force: true }).catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.log(`[${label}] confirm click ${clicks + 1}: ${(e as Error).message.split('\n')[0]}`);
    });
    clicks++;
    const tookEffect = await new Promise<boolean>((resolve) => {
      if (popup.isClosed() || settled) {
        resolve(true);
        return;
      }
      let done = false;
      const finish = (effect: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        popup.off('close', onClose);
        resolve(effect);
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(false), CONFIRM_EFFECT_PROBE_MS);
      popup.once('close', onClose);
      opts.resolved?.then(() => finish(true), () => finish(true));
      confirm.waitFor({ state: 'hidden', timeout: CONFIRM_EFFECT_PROBE_MS }).then(() => finish(true), () => undefined);
    });
    if (tookEffect) break;
  }
  return { clicks };
}
