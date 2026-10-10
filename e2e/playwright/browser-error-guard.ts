import type { BrowserContext, Page } from '@playwright/test';

/**
 * Shortest pattern source `expectBrowserError` accepts. A pattern this short
 * cannot name one specific message: `/Failed/`, `/400/`, `/net::/` and a bare
 * dot-star all match whole families of unrelated errors. Twelve characters is enough
 * for `status of 400` or `request cancel`, too few for a catch-all.
 */
export const MIN_EXPECTED_ERROR_PATTERN_LENGTH = 12;

/**
 * Shortest reason `expectBrowserError` accepts. A reason names the action that
 * provokes the error ("the spec fulfils POST /api/tx with 400"); fifteen
 * characters is more than "expected" or "flaky" and less than any real one.
 */
export const MIN_EXPECTED_ERROR_REASON_LENGTH = 15;

/** The guard {@link installContextErrorGuard} returns. */
export interface BrowserErrorGuard {
  /** Drops recorded errors, failed requests and expectations. Call in `beforeEach`. */
  resetPerTest(): void;
  /**
   * Declares that THIS test's own action provokes exactly this browser error.
   *
   * Not an allowlist. On {@link assertClean} the pattern MUST have matched at
   * least one recorded error, or the test fails because the provoked error
   * never appeared. Only the matched errors are consumed; every other error
   * still fails the test. The declaration lives until the next
   * `assertClean()` or `resetPerTest()`, so it covers one test and never a
   * whole file.
   *
   * Refused at call time: a pattern whose source is shorter than
   * {@link MIN_EXPECTED_ERROR_PATTERN_LENGTH} or that matches an arbitrary
   * unrelated message (a catch-all), a pattern with the `g` or `y` flag
   * (stateful `lastIndex` makes `test()` alternate), and a reason shorter than
   * {@link MIN_EXPECTED_ERROR_REASON_LENGTH}.
   *
   * @param pattern matches the one message the action provokes, as recorded:
   *   `[console.error] <text>` or `[pageerror] <message>`.
   * @param reason the provoking action, e.g. `'the spec fulfils POST /api/tx
   *   with 400 to prove the broadcast error path'`.
   */
  expectBrowserError(pattern: RegExp, reason: string): void;
  /**
   * Throws when an expected error did not appear or an unexpected one did.
   * The message lists every unexpected error, every missing expectation and
   * every request that failed on a guarded page, so a bare
   * `Failed to load resource: net::ERR_FAILED` names its URL. Clears the
   * guard's state either way.
   */
  assertClean(): void;
}

/**
 * A message no real browser error contains. A pattern matching it matches
 * text it was never written for, so it is a catch-all and refused.
 */
const UNRELATED_PROBE = 'zq9 unrelated probe 7xw';

interface Expectation {
  pattern: RegExp;
  reason: string;
}

/**
 * Install a context-level guard that records uncaught JS exceptions,
 * `console.error` messages and failed requests from every app page the
 * context spawns. Any recorded error fails the test (E2E_BEST_PRACTICES.md:
 * browser errors fail the test, and none of them are suppressed).
 *
 * The guard hooks `context.on('page', …)` so tests need nothing at
 * page-creation sites. Wallet-extension pages (`chrome-extension://…`) and
 * `about:` pages are outside it: an extension bundle's own console output is
 * the vendor's, and a page that never navigated has no app on it. A vendor
 * website a wallet opens in a tab IS inside it; shield that through the
 * wallet's SDK helper (`installOkxOfflineRoutes`, `installWizzOfflineRoutes`).
 *
 * Only `error`-level console messages and `pageerror` are recorded; warnings
 * and info/log/debug are not errors.
 *
 * A test that provokes an error on purpose (a fulfilled 400, a cancelled
 * wallet popup) declares it with `expectBrowserError`, which asserts the
 * error happened and consumes only that error.
 *
 * Twin file lives at
 * ~/Work/ordpool/cat21-indexer/frontend/e2e/regtest/lib/browser-error-guard.ts;
 * keep them in step.
 */
export function installContextErrorGuard(context: BrowserContext): BrowserErrorGuard {
  let errors: string[] = [];
  let failedRequests: string[] = [];
  let expectations: Expectation[] = [];

  const isAppUrl = (url: string): boolean =>
    url !== '' && !url.startsWith('chrome-extension://') && !url.startsWith('about:');
  const isAppPage = (page: Page): boolean => isAppUrl(page.url());

  context.on('page', (page) => {
    page.on('pageerror', (err) => {
      if (!isAppPage(page)) return;
      errors.push(`[pageerror] ${err.message}${err.stack ? '\n' + err.stack : ''}`);
    });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      if (!isAppPage(page)) return;
      errors.push(`[console.error] ${msg.text()}`);
    });
    page.on('requestfailed', (request) => {
      if (!isAppPage(page)) return;
      failedRequests.push(`${request.failure()?.errorText ?? 'failed'} ${request.method()} ${request.url()}`);
    });
  });

  const reset = (): void => {
    errors = [];
    failedRequests = [];
    expectations = [];
  };

  return {
    resetPerTest: reset,

    expectBrowserError(pattern: RegExp, reason: string): void {
      if (pattern.global || pattern.sticky) {
        throw new Error(`expectBrowserError: /${pattern.source}/${pattern.flags} carries the g or y flag; test() on it is stateful`);
      }
      if (pattern.source.length < MIN_EXPECTED_ERROR_PATTERN_LENGTH || pattern.test(UNRELATED_PROBE) || pattern.test('')) {
        throw new Error(
          `expectBrowserError: /${pattern.source}/ does not name one specific message ` +
          `(at least ${MIN_EXPECTED_ERROR_PATTERN_LENGTH} characters, and no catch-all)`,
        );
      }
      if (reason.trim().length < MIN_EXPECTED_ERROR_REASON_LENGTH) {
        throw new Error(
          `expectBrowserError: reason "${reason}" must name the action that provokes the error ` +
          `(at least ${MIN_EXPECTED_ERROR_REASON_LENGTH} characters)`,
        );
      }
      expectations.push({ pattern, reason });
    },

    assertClean(): void {
      const missing = expectations.filter((e) => !errors.some((text) => e.pattern.test(text)));
      const unexpected = errors.filter((text) => !expectations.some((e) => e.pattern.test(text)));
      const requests = failedRequests;
      reset();
      if (missing.length === 0 && unexpected.length === 0) return;

      const parts: string[] = [];
      if (unexpected.length > 0) {
        parts.push(`Browser surfaced ${unexpected.length} unexpected error(s):\n\n${unexpected.join('\n\n')}`);
      }
      for (const e of missing) {
        parts.push(`expected the provoked error /${e.pattern.source}/ (${e.reason}) but it never appeared`);
      }
      if (requests.length > 0) {
        parts.push(`Requests that failed on guarded pages:\n${requests.map((r) => `  - ${r}`).join('\n')}`);
      }
      throw new Error(parts.join('\n\n'));
    },
  };
}
