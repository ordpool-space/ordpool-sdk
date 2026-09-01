"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clickRadixCheckbox = clickRadixCheckbox;
const test_1 = require("@playwright/test");
/**
 * Click a Radix UI Checkbox primitive and assert the toggle landed.
 *
 * Radix renders a checkbox as TWO elements:
 *   <button role="checkbox" data-state="unchecked">  ← state lives here
 *   <input type="checkbox" aria-hidden tabindex="-1">  ← form submit only
 *
 * Radix tracks the checked state on the BUTTON's `data-state`
 * attribute; the hidden <input> is wired to the surrounding <form>
 * for native submission and does NOT receive React state updates.
 * That's why a synthetic <label> click or a direct
 * `cb.checked = true` on the input is unreliable — Radix isn't
 * listening to either signal.
 *
 * The deterministic primitive is `getByRole('checkbox').click()` —
 * Playwright maps the role selector to the BUTTON, and the click
 * triggers Radix's internal state transition. We assert
 * `data-state='checked'` right after the click so the spec fails
 * with a useful message if the click didn't land instead of
 * waiting for whatever downstream gate would otherwise time out.
 */
async function clickRadixCheckbox(page, options = {}) {
    const { nth = 0, timeoutMs = 5_000 } = options;
    const checkbox = page.getByRole('checkbox').nth(nth);
    await (0, test_1.expect)(checkbox).toBeVisible({ timeout: 10_000 });
    await checkbox.click();
    await (0, test_1.expect)(checkbox).toHaveAttribute('data-state', 'checked', { timeout: timeoutMs });
}
//# sourceMappingURL=radix-checkbox.js.map