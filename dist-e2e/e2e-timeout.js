"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.E2E_TIMEOUT_ENV = void 0;
exports.e2eTimeoutMs = e2eTimeoutMs;
/**
 * The per-wait bound of an e2e run, as the SDK's helpers read it.
 *
 * Every wait in a test is bounded by one value, set once in the runner config
 * (TESTING.md, "Patterns no spec may contain"). Playwright-side waits (locators,
 * popups, page events) need nothing from here: they run under the config's own
 * `expect.timeout`, `actionTimeout` and `navigationTimeout`, which carry the same
 * value. The helpers that poll OUTSIDE Playwright (bitcoind RPC, electrs, ord,
 * the filesystem, a wallet's service worker) are not Playwright waits, so they
 * stop at this bound. No helper takes a per-call timeout.
 *
 * The per-wait bound is not the test bound. A test is a sequence of waits, and
 * the runner config bounds it separately:
 *
 *     // playwright.config.ts
 *     const WAIT_TIMEOUT_MS = 30_000;
 *     process.env.ORDPOOL_E2E_TIMEOUT_MS = String(WAIT_TIMEOUT_MS);
 *     export default defineConfig({
 *       timeout: TEST_TIMEOUT_MS,
 *       expect: { timeout: WAIT_TIMEOUT_MS },
 *       use: { actionTimeout: WAIT_TIMEOUT_MS, navigationTimeout: WAIT_TIMEOUT_MS },
 *     });
 *
 *     // jest.config.regtest.js
 *     const WAIT_TIMEOUT_MS = 30_000;
 *     process.env.ORDPOOL_E2E_TIMEOUT_MS = String(WAIT_TIMEOUT_MS);
 *     module.exports = { testTimeout: TEST_TIMEOUT_MS, ... };
 *
 * Both runners evaluate the config before any spec, and their workers inherit
 * the environment, so every helper in every worker sees the value. A state that
 * needs longer than this bound to arrive is a defect in the app, the harness or
 * the helper, fixed there, never by raising the bound.
 */
exports.E2E_TIMEOUT_ENV = 'ORDPOOL_E2E_TIMEOUT_MS';
/**
 * The per-wait bound in milliseconds, read at call time so a config that
 * imports this module before assigning the variable still works.
 *
 * Throws when the variable is missing or not a positive integer. There is no
 * default: a default here would be a second bound, defined somewhere other
 * than the runner config, and the helpers would disagree with the config's
 * Playwright waits without anyone noticing.
 */
function e2eTimeoutMs() {
    const raw = process.env[exports.E2E_TIMEOUT_ENV];
    const ms = raw === undefined ? NaN : Number(raw);
    if (!Number.isInteger(ms) || ms <= 0) {
        throw new Error(`${exports.E2E_TIMEOUT_ENV} is ${raw === undefined ? 'not set' : `"${raw}"`}. ` +
            'Set it in the runner config to the per-wait bound ' +
            `(process.env.${exports.E2E_TIMEOUT_ENV} = String(WAIT_TIMEOUT_MS)); the SDK's polling helpers stop at that bound.`);
    }
    return ms;
}
//# sourceMappingURL=e2e-timeout.js.map