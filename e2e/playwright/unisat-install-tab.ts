import type { BrowserContext } from '@playwright/test';

/**
 * The install tab of UniSat 1.7.15 and its fork Wizz 2.13.4, and the state in
 * which it can no longer disturb a test.
 *
 * Both background service workers register `runtime.onInstalled` and, for
 * reason `"install"`, poll their own "initialised" flag every second and open
 * `index.html` in a new tab once it is set:
 *
 *     UniSat  (0,n.nw)(e=>{"install"===e.reason&&i()});
 *             let i=()=>{(0,r.dF)()?(0,t.pd)("index.html",{}):setTimeout(()=>{i()},1e3)}
 *     Wizz    const w=()=>{m?(0,s.pd)():setTimeout((()=>{w()}),1e3)};
 *             (0,l.nw)((e=>{"install"===e.reason&&w()}))
 *
 * That tab boots through the root route, which rejects any pending approval
 * when it is not the notification window (`BoostScreen`:
 * `isNotification || rejectApproval()`), so a connect sent before it booted
 * gets 4001 "User rejected the request".
 *
 * The listener is registered late. Both bundles are webpack async module graphs
 * that wait for their `.module.wasm` files (`fetch` + `instantiateStreaming`)
 * before any module body runs, and the `onInstalled` listener is added in one
 * of those bodies. Chrome dispatches `runtime.onInstalled` once the worker's
 * top-level script has run (`RuntimeEventRouter::DispatchOnInstalledEvent`,
 * `DispatchEventWithLazyListener`). When the dispatch arrives while the worker
 * still waits for its wasm, no listener exists yet, the event is gone, and the
 * wallet never opens the tab. The wallet itself works normally, it just never
 * shows its welcome tab. Whether the listener or the dispatch comes first is
 * the wallet's race with Chrome, not ours.
 *
 * So the tab either opens and boots, or never opens, and only the background
 * knows which. What it shows the outside is the moment it finished
 * initialising. UniSat starts its phishing service and sets its flag in the
 * same turn (`u.Ui.init({...}),f=!0`), and the service's first requests are
 * the phishing-list downloads, so they go out after the flag is set. Wizz sets
 * `m` right after its RGB++ test-network token requests settle
 * (`generateJWT`). The offline routes see those requests and record the time
 * here. From then on, a wallet that received `onInstalled` opens the tab at
 * its next poll; one that did not never will.
 */

/** UniSat and Wizz check their initialised flag once per second before opening the install tab (`setTimeout(..., 1e3)` above). */
export const INSTALL_TAB_POLL_MS = 1_000;

/**
 * Probe: how long after the background finished initialising the install tab
 * gets to show up as a page before it counts as never opening. One poll period
 * for the wallet to call `tabs.create`, plus two for Chrome to create the tab
 * and Playwright to report it on a loaded runner. Locally the page event came
 * 1.0 s after the init request, for both wallets.
 */
export const INSTALL_TAB_PROBE_MS = INSTALL_TAB_POLL_MS + 2_000;

const initialisedAt = new WeakMap<BrowserContext, number>();

/**
 * Record that the wallet's background in `context` finished initialising, at
 * `at`. Called by the offline routes on the first request the background
 * sends only after its init (`installUnisatOfflineRoutes`,
 * `installWizzOfflineRoutes`); later calls keep the first time.
 */
export function markWalletBackgroundInitialised(context: BrowserContext, at: number = Date.now()): void {
  if (!initialisedAt.has(context)) initialisedAt.set(context, at);
}

/** When the wallet's background in `context` finished initialising, if the offline routes saw it. */
export function walletBackgroundInitialisedAt(context: BrowserContext): number | undefined {
  return initialisedAt.get(context);
}

/**
 * Where the install tab stands.
 *
 * - `booted`: a tab of the extension has left the root route for a screen
 *   (`#/main`, or `#/welcome` when it booted before the vault existed). The
 *   rejection runs once, on that boot, so it is behind us.
 * - `booting`: a tab of the extension is still on `index.html` or its root
 *   route `#/`, so its rejection is still ahead.
 * - `background-initialising`: no install tab, and the background has not
 *   finished initialising, so a tab may still be on its way.
 * - `poll-pending`: no install tab, the background has initialised, and its
 *   next poll may still open one.
 * - `never-opens`: no install tab, and the poll after the background
 *   initialised has passed without one. The wallet did not receive
 *   `onInstalled` and will not open the tab.
 */
export type InstallTabState = 'booted' | 'booting' | 'background-initialising' | 'poll-pending' | 'never-opens';

/** The states in which no install tab can reject an approval any more. */
export const INSTALL_TAB_SETTLED: readonly InstallTabState[] = ['booted', 'never-opens'];

/**
 * Classify the install tab from the URLs of the context's pages other than the
 * one driving onboarding, the time the background finished initialising
 * (`walletBackgroundInitialisedAt`), and `now`.
 */
export function installTabState(o: {
  extensionId: string;
  otherPageUrls: readonly string[];
  initialisedAt: number | undefined;
  now: number;
}): InstallTabState {
  const index = `chrome-extension://${o.extensionId}/index.html`;
  const tabs = o.otherPageUrls.filter((u) => u === index || u.startsWith(`${index}#`));
  if (tabs.some((u) => /^#\/[a-z]/.test(u.slice(index.length)))) return 'booted';
  if (tabs.length > 0) return 'booting';
  if (o.initialisedAt === undefined) return 'background-initialising';
  return o.now - o.initialisedAt < INSTALL_TAB_PROBE_MS ? 'poll-pending' : 'never-opens';
}
