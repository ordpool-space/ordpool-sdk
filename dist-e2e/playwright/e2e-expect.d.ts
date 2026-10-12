import { expect as playwrightExpect, type BrowserContext, type Page } from '@playwright/test';
/**
 * Playwright's `expect`, bounded by `e2eTimeoutMs()` wherever it runs.
 *
 * Inside a test, Playwright's own `expect` waits for the config's
 * `expect.timeout`. Outside one (a consumer's globalSetup, a seeding script)
 * there is no test and it falls back to its built-in 5 s, whatever the config
 * says. Every SDK helper asserts through this one instead, so a helper waits
 * for the same per-wait bound in a test and outside it. The bound is read at
 * each call, so a config that sets `ORDPOOL_E2E_TIMEOUT_MS` after this module
 * loads still applies, and `@playwright/test` is first touched at that call.
 */
export declare const e2eExpect: typeof playwrightExpect;
/**
 * Sets the default action and navigation timeout of `target` to
 * `e2eTimeoutMs()`. A context Playwright's test runner did not create has the
 * library defaults (30 s per action and per navigation), not the
 * config's `actionTimeout` and `navigationTimeout`; every SDK launch calls this
 * on what it returns, so a helper's locator waits in globalSetup stop at the
 * same bound as in a test.
 */
export declare function boundByE2eTimeout(target: Pick<BrowserContext | Page, 'setDefaultTimeout' | 'setDefaultNavigationTimeout'>): void;
//# sourceMappingURL=e2e-expect.d.ts.map