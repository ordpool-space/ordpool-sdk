import type { BrowserContext } from '@playwright/test';
/**
 * Shortest pattern source `expectBrowserError` accepts. A pattern this short
 * cannot name one specific message: `/Failed/`, `/400/`, `/net::/` and a bare
 * dot-star all match whole families of unrelated errors. Twelve characters is enough
 * for `status of 400` or `request cancel`, too few for a catch-all.
 */
export declare const MIN_EXPECTED_ERROR_PATTERN_LENGTH = 12;
/**
 * Shortest reason `expectBrowserError` accepts. A reason names the action that
 * provokes the error ("the spec fulfils POST /api/tx with 400"); fifteen
 * characters is more than "expected" or "flaky" and less than any real one.
 */
export declare const MIN_EXPECTED_ERROR_REASON_LENGTH = 15;
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
     * every request that failed or answered 4xx/5xx on a guarded page, so a
     * bare `Failed to load resource: ...` names its URL. Clears the
     * guard's state either way.
     */
    assertClean(): void;
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
 */
export declare function installContextErrorGuard(context: BrowserContext): BrowserErrorGuard;
//# sourceMappingURL=browser-error-guard.d.ts.map