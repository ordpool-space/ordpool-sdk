import { Locator, Page } from '@playwright/test';

/**
 * Dispatch a real mouse click at an element's centre over CDP.
 *
 * Some extension onboarding controls ignore Playwright's synthetic clicks, so
 * these flows drop one layer down to `Input.dispatchMouseEvent`. That requires
 * coordinates, which requires a layout box.
 *
 * The shape this replaces was:
 *
 *     const box = await btn.boundingBox();
 *     if (box) { ...dispatch... }
 *
 * `boundingBox()` returns null for an element that is not laid out, so the
 * click was SILENTLY SKIPPED and the next `waitForFunction` then burned its
 * full ceiling waiting for a screen that could never arrive. The failure
 * surfaced a minute later against an unrelated condition, and in a suite it
 * took sibling specs down with it through a failed `beforeAll`, none of which
 * pointed at the click that never happened.
 *
 * Here the step either happens or fails naming the control.
 */
export async function cdpClick(page: Page, locator: Locator, what: string): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: 15_000 });
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error(`cdpClick: ${what} is visible but has no layout box, so the click cannot be dispatched`);
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
