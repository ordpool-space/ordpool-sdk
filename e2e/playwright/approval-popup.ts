import type { BrowserContext, Locator, Page } from '@playwright/test';
import { ClickableControl, clickUntilEffect } from './click-until-effect';

/**
 * `isApproval` anchored on the control the caller is about to use. `url` only
 * narrows; `control` decides. Both share one budget.
 */
export function approvalGate(opts: {
  url?: RegExp;
  control: (page: Page) => Locator;
  timeoutMs?: number;
}): (page: Page) => Promise<boolean> {
  const budgetMs = opts.timeoutMs ?? 60_000;
  return async (page: Page): Promise<boolean> => {
    const deadline = Date.now() + budgetMs;
    if (opts.url) await page.waitForURL(opts.url, { timeout: budgetMs });
    const remaining = Math.max(1_000, deadline - Date.now());
    await opts.control(page).waitFor({ state: 'visible', timeout: remaining });
    return true;
  };
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
 * `isApproval` may throw (e.g. its internal timeout fires) — the
 * helper swallows the throw and keeps waiting on the OTHER pages,
 * which is the right behaviour: one page failing the match shouldn't
 * abort the search.
 *
 * The outer `timeoutMs` is the deadline beyond which we reject. It
 * is NOT a poll interval — it's a hard rejection timer enforced via
 * a single setTimeout.
 */
export async function waitForApprovalPopup(opts: {
  context: BrowserContext;
  knownPages: Set<Page>;
  isApproval: (p: Page) => boolean | Promise<boolean>;
  timeoutMs?: number;
}): Promise<Page> {
  const { context, knownPages, isApproval } = opts;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return new Promise<Page>((resolve, reject) => {
    let settled = false;

    const finishOk = (p: Page) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(p);
    };
    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

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
        // quick succession, passing on retry.
        //
        // So require the page to answer a round-trip before returning it. A
        // page that is going away cannot, and the search continues for the one
        // that is actually live. This is a liveness check rather than a delay:
        // nothing is waited out, the page either responds or it does not.
        await p.title();
        if (p.isClosed()) return;

        finishOk(p);
      } catch {
        // isApproval rejected (e.g. internal timeout), or the liveness probe
        // failed because the page went away. Don't abort the search — another
        // page may still match.
      }
    };

    const onPage = (p: Page) => void tryPage(p);

    const timer = setTimeout(
      () => finishErr(new Error(`approval popup did not appear within ${timeoutMs}ms`)),
      timeoutMs,
    );

    const cleanup = () => {
      clearTimeout(timer);
      context.off('page', onPage);
    };

    context.on('page', onPage);
    for (const p of context.pages()) void tryPage(p);
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
  /** Wait for the popup itself. Default 120s. */
  popupTimeoutMs?: number;
  /** Wait for the Sign button to become clickable. Default 60s. */
  signTimeoutMs?: number;
  onScreenshot?: (page: Page, name: string) => Promise<void>;
}): Promise<void> {
  const popupTimeoutMs = opts.popupTimeoutMs ?? 120_000;
  const approval = await waitForApprovalPopup({
    context: opts.context,
    knownPages: opts.knownPages,
    timeoutMs: popupTimeoutMs,
    // Anchored on the Sign button; the plain-string NAME form is the one that
    // matches this control, measured rather than inferred.
    isApproval: approvalGate({
      url: /notification\.html#\/approval/,
      control: (p) => p.getByRole('button', { name: 'Sign' }),
      timeoutMs: popupTimeoutMs,
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

  const found = await approval.waitForFunction(
    describeSign, undefined, { timeout: opts.signTimeoutMs ?? 60_000, polling: 250 },
  );
  // Reported so these gates can be anchored on the real element. Wizz strips
  // data-testid. The six Wizz SIGN gates stay URL-only until a locator is
  // verified against a real run: 94b5e2a anchored them on
  // getByRole('button', { name: /^Sign$/ }) from this line's `text` field and
  // all six specs then failed with "approval popup did not appear". textContent
  // is not the accessible name, so the next attempt must measure the NAME, or
  // use locator('button', { hasText }) which matches on text.
  // One check, not a description: does the anchor the gate above uses still
  // match exactly one control? A future Wizz release that renames the button
  // shows up here as 0 instead of as a 120s gate timeout.
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
 * How long a target-closed click error is allowed to wait for the close to be
 * observable. The close and the click's rejection race; this only covers the
 * gap between them.
 */
const CLOSE_GRACE_MS = 2_000;

export async function clickApprovalButton(
  button: { click: (opts?: { timeout?: number }) => Promise<void> },
  page: { isClosed: () => boolean },
  timeoutMs = 15_000,
): Promise<void> {
  try {
    await button.click({ timeout: timeoutMs });
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
    click: (opts?: { timeout?: number }) => Promise<void>;
    isVisible: () => Promise<boolean>;
    isEnabled: () => Promise<boolean>;
  },
  page: { isClosed: () => boolean },
  opts: { clickTimeoutMs?: number; closeTimeoutMs?: number; label?: string } = {},
): Promise<void> {
  const label = opts.label ?? 'approval popup';
  await clickApprovalButton(button, page, opts.clickTimeoutMs ?? 15_000);

  const deadline = Date.now() + (opts.closeTimeoutMs ?? 20_000);
  while (!page.isClosed()) {
    if (Date.now() > deadline) {
      const visible = await button.isVisible().catch(() => false);
      const enabled = visible ? await button.isEnabled().catch(() => false) : false;
      const diagnosis =
        visible && enabled
          ? 'the button is STILL VISIBLE AND ENABLED, which is the swallowed-click signature'
          : 'the button is gone or disabled, so the click registered and the wallet did not finish';
      throw new Error(
        `${label}: clicked the confirm button and the popup never closed. ` +
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
 * no after 60s it cannot say whether the wallet failed to wake or the CLICK
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
 * instead of a 60-second timeout blamed on the wallet.
 *
 * For an SDK-driven approval — the harness calls the orchestrator and the
 * wallet pops up on its own — there is no trigger to re-click, so use
 * `waitForApprovalPopup` directly. This is for a PAGE-driven trigger only.
 */
export async function clickUntilApprovalPopup(
  trigger: ClickableControl,
  opts: {
    context: BrowserContext;
    knownPages: Set<Page>;
    isApproval: (p: Page) => boolean | Promise<boolean>;
    /** How long ONE click gets to produce the popup. */
    settleMs?: number;
    maxClicks?: number;
    label?: string;
  },
): Promise<{ page: Page; clicks: number }> {
  let found: Page | null = null;
  const effect = {
    waitFor: async ({ timeout }: { state: 'visible'; timeout: number }) => {
      found = await waitForApprovalPopup({
        context: opts.context,
        knownPages: opts.knownPages,
        isApproval: opts.isApproval,
        timeoutMs: timeout,
      });
    },
  };

  const { clicks } = await clickUntilEffect(trigger, effect, {
    settleMs: opts.settleMs ?? 20_000,
    maxClicks: opts.maxClicks ?? 3,
    label: opts.label ?? 'approval trigger',
  });

  if (!found) throw new Error(`${opts.label ?? 'approval trigger'}: popup resolved without a page`);
  return { page: found, clicks };
}

/**
 * Wait for the extension page that is offering a CONFIRM BUTTON.
 *
 * Replaces a pattern that was hand-copied across most wallet specs: poll every
 * extension page's body text every 500ms against a list of headings, until a
 * deadline. That shape has two defects, and neither is a property of the wallet.
 *
 * It makes the result depend on MACHINE SPEED. One such spec passed in 5.4
 * seconds on an idle runner and timed out at 120 on a loaded one, with
 * identical code and extension. A test whose verdict moves with CPU contention
 * is a bad test, not an unlucky one.
 *
 * And it couples the spec to the wallet's COPY. Wallets rename headings between
 * releases, so a rename reads as a broken flow.
 *
 * A confirm button is what the caller needs next, so waiting for it removes the
 * gap between "a heading appeared" and "something is clickable", and it is
 * driven by Playwright's own event-based waiting rather than a busy loop. The
 * search covers pages that are ALREADY open as well as ones that appear, which
 * matters for wallets that reuse one notification page across approvals.
 */
export async function waitForApprovalByConfirmButton(opts: {
  context: BrowserContext;
  /** What the confirm control says. Default covers the common wallet verbs. */
  buttonText?: RegExp;
  timeoutMs?: number;
  /** Named in the failure message, e.g. 'mint' or 'listing-message'. */
  label?: string;
}): Promise<Page> {
  const buttonText = opts.buttonText ?? /^(Confirm|Sign|Approve)$/;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const label = opts.label ?? 'approval';

  // Which extension pages existed BEFORE we started waiting. A blank page that
  // was already open is a stale one the wallet is reusing and never
  // re-rendering; a blank page that appeared while we waited is one the wallet
  // opened fresh and never painted. Same symptom, different cause, and only
  // this distinction separates them.
  const preexisting = new Set(opts.context.pages().filter((p) => p.url().startsWith('chrome-extension://')));

  try {
    return await waitForApprovalPopup({
      context: opts.context,
      // Empty on purpose: a wallet may serve this approval from the SAME page
      // it used for an earlier one, and a populated set would skip it.
      knownPages: new Set<Page>(),
      timeoutMs,
      isApproval: async (p) => {
        if (!p.url().startsWith('chrome-extension://')) return false;
        await p.getByText(buttonText, { exact: true }).first()
          .waitFor({ state: 'visible', timeout: timeoutMs });
        return true;
      },
    });
  } catch (e) {
    const seen = await Promise.all(
      opts.context.pages()
        .filter((p) => p.url().startsWith('chrome-extension://'))
        .map(async (p) => {
          const text = await p.locator('body').innerText().catch(() => '<unreadable>');
          const age = preexisting.has(p) ? 'ALREADY-OPEN' : 'opened-while-waiting';
          return `${p.url().slice(0, 60)} [${age}] => ${text.trim().split('\n')[0]?.slice(0, 80) || '<empty>'}`;
        }),
    );
    throw new Error(
      `${label}: no extension page offered a confirm button within ${timeoutMs}ms (${(e as Error).message})\n` +
      `Extension pages at timeout (${seen.length}):\n` +
      (seen.length ? seen.map((l) => `  - ${l}`).join('\n') : '  <none>') +
      '\nA page shown as <empty> never painted. ALREADY-OPEN means the wallet is reusing a ' +
      'stale page and not re-rendering it, so closing leftovers before the request is the fix; ' +
      'opened-while-waiting means the wallet opened a fresh page and failed to render it, which ' +
      'is the wallet\'s own defect. A page with text is neither: the matcher does not know it.',
    );
  }
}

/**
 * Resolve to the page currently SHOWING `text`, across pages that are already
 * open and pages that appear while waiting.
 *
 * Extension onboarding hands a step to an unpredictable page: a wallet may
 * continue in the tab you have, or open a fresh one, and which it does varies
 * by version. The specs handled that by polling every page's innerText every
 * 500ms until a deadline, then continuing on the original page if nothing
 * matched. So on a slow machine the search could expire before the wallet
 * painted, and the flow would carry on against the WRONG page and fail later
 * somewhere unrelated.
 *
 * This waits on Playwright's event-driven text matching instead, so it returns
 * the moment the text appears rather than on the next tick of a timer, and it
 * throws rather than silently yielding null. A caller that genuinely treats the
 * step as optional can still `.catch(() => null)`, but it has to say so.
 */
export async function waitForPageShowing(opts: {
  context: BrowserContext;
  text: RegExp;
  timeoutMs?: number;
  label?: string;
}): Promise<Page> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  try {
    return await waitForApprovalPopup({
      context: opts.context,
      knownPages: new Set<Page>(),
      timeoutMs,
      isApproval: async (p) => {
        await p.getByText(opts.text).first().waitFor({ state: 'visible', timeout: timeoutMs });
        return true;
      },
    });
  } catch (e) {
    throw new Error(
      `${opts.label ?? 'page'}: no page showed ${opts.text} within ${timeoutMs}ms (${(e as Error).message})`,
    );
  }
}
