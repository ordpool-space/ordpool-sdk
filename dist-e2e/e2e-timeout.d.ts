/**
 * The one global timeout of an e2e run, as the SDK's helpers read it.
 *
 * Every wait in a test is bounded by one value, set once in the runner config
 * (TESTING.md, "Patterns no spec may contain"). Playwright-side waits (locators,
 * popups, page events) need nothing from here: they run under the config's own
 * `timeout` / `expect.timeout`. The helpers that poll OUTSIDE Playwright
 * (bitcoind RPC, electrs, ord, the filesystem, a wallet's service worker) are
 * not Playwright waits and would poll forever after the test timed out, so they
 * stop at this bound. No helper takes a per-call timeout.
 *
 * The runner config sets the variable to the same value as its test timeout:
 *
 *     // playwright.config.ts
 *     const TIMEOUT_MS = 600_000;
 *     process.env.ORDPOOL_E2E_TIMEOUT_MS = String(TIMEOUT_MS);
 *     export default defineConfig({ timeout: TIMEOUT_MS, expect: { timeout: TIMEOUT_MS }, ... });
 *
 *     // jest.config.regtest.js
 *     const TIMEOUT_MS = 600_000;
 *     process.env.ORDPOOL_E2E_TIMEOUT_MS = String(TIMEOUT_MS);
 *     module.exports = { testTimeout: TIMEOUT_MS, ... };
 *
 * Both runners evaluate the config before any spec, and their workers inherit
 * the environment, so every helper in every worker sees the value.
 */
export declare const E2E_TIMEOUT_ENV = "ORDPOOL_E2E_TIMEOUT_MS";
/**
 * The global bound in milliseconds, read at call time so a config that imports
 * this module before assigning the variable still works.
 *
 * Throws when the variable is missing or not a positive integer. There is no
 * default: a default here would be a second timeout, defined somewhere other
 * than the runner config, and the helper would disagree with the test's own
 * bound without anyone noticing.
 */
export declare function e2eTimeoutMs(): number;
//# sourceMappingURL=e2e-timeout.d.ts.map