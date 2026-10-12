"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.e2eExpect = void 0;
exports.boundByE2eTimeout = boundByE2eTimeout;
const test_1 = require("@playwright/test");
const e2e_timeout_1 = require("../e2e-timeout");
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
exports.e2eExpect = new Proxy((() => undefined), {
    apply(_target, thisArg, args) {
        return Reflect.apply(bounded(), thisArg, args);
    },
    get(_target, property) {
        return Reflect.get(bounded(), property);
    },
});
function bounded() {
    return test_1.expect.configure({ timeout: (0, e2e_timeout_1.e2eTimeoutMs)() });
}
/**
 * Sets the default action and navigation timeout of `target` to
 * `e2eTimeoutMs()`. A context Playwright's test runner did not create has the
 * library defaults (30 s per action and per navigation), not the
 * config's `actionTimeout` and `navigationTimeout`; every SDK launch calls this
 * on what it returns, so a helper's locator waits in globalSetup stop at the
 * same bound as in a test.
 */
function boundByE2eTimeout(target) {
    const ms = (0, e2e_timeout_1.e2eTimeoutMs)();
    target.setDefaultTimeout(ms);
    target.setDefaultNavigationTimeout(ms);
}
//# sourceMappingURL=e2e-expect.js.map