"use strict";
/**
 * The one sanctioned wait for time (TESTING.md, "When no state can be waited
 * on, the exception is a named method with a reason").
 *
 * Last resort, for the case where the app or the wallet offers NO observable
 * signal for the thing the test has to let pass: no element, no attribute, no
 * event, no network response. `reason` names the concrete thing waited for and
 * why it has no state, e.g. `'wallet popup debounceTime(300) before submit'`.
 *
 * Every call is a defect report against the app or the wallet. The right fix is
 * a state to wait on (`aria-busy`, a `data-state`, an emitted event), and once
 * it exists the call goes. `scripts/check-test-kinds.mjs` counts the calls per
 * repo and rejects a reason that is not a string literal of at least
 * `MIN_WORKAROUND_REASON_LENGTH` characters; this function rejects the same at
 * run time, so a reason built at run time cannot slip past the checker either.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_WORKAROUND_REASON_LENGTH = void 0;
exports.workaroundWaitForTimeout = workaroundWaitForTimeout;
/**
 * Shortest reason accepted. `'flaky'` and `'wait a bit'` name nothing; a reason
 * that names a component and its missing signal does not fit below this.
 * Equal to `MIN_REASON_LENGTH` in `scripts/check-test-kinds.mjs`.
 */
exports.MIN_WORKAROUND_REASON_LENGTH = 15;
async function workaroundWaitForTimeout(page, ms, reason) {
    if (typeof reason !== 'string' || reason.trim().length < exports.MIN_WORKAROUND_REASON_LENGTH) {
        throw new Error(`workaroundWaitForTimeout: reason "${String(reason)}" is shorter than ${exports.MIN_WORKAROUND_REASON_LENGTH} characters. ` +
            'Name the concrete thing waited for and why it has no observable state.');
    }
    if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error(`workaroundWaitForTimeout: ms must be a positive number, got ${ms} (${reason})`);
    }
    await page.waitForTimeout(ms);
}
//# sourceMappingURL=workaround-wait-for-timeout.js.map