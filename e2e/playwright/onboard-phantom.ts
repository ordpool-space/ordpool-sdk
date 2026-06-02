import { expect, Page } from '@playwright/test';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

/**
 * Drive Phantom v26 onboarding from welcome to the "You're good to go"
 * completion screen. Multi-page flow (CI iterations 22-30, 2026-05-31):
 *
 *   - Welcome → "I Already Have a Wallet" (anti-automation filter,
 *     needs raw CDP Input.dispatchMouseEvent).
 *   - Import-a-wallet picker → "Import Recovery Phrase".
 *   - 12 mnemonic input boxes → Import Wallet.
 *   - "Import Accounts — Finding Accounts with Activity" loading,
 *     transitions to "We found N accounts with activity" result. The
 *     result may render on a NEW page (Phantom replaces the tab); poll
 *     context.pages() for the result-state marker.
 *   - Continue (rendered as a styled <div>, not a real button) once
 *     Phantom finishes deriving account info (opacity gate).
 *   - YET another new page for "Create a password" — switch reference.
 *   - Password + Confirm Password fields; Reach UI custom-checkbox
 *     Terms (the <input> is visually hidden, dispatch native .click()
 *     via JS so React's onChange toggles aria-checked); Continue.
 *   - "You're good to go!" completion gate with a "Get Started" CTA.
 *     The button is bombproof against every click strategy tried
 *     (CDP / pointer / programmatic / Tab+Enter). We attempt one
 *     CDP+pointer-event volley and leave the wallet on the completion
 *     screen — callers can navigate to popup.html afterwards.
 */
export async function onboardPhantom(page: Page, extensionId: string): Promise<void> {
  if (page.url() === 'about:blank') {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'networkidle' });
  }

  const importBtn = page.getByRole('button', { name: 'I Already Have a Wallet' });
  await expect(importBtn).toBeVisible({ timeout: 30_000 });
  const cdp = await page.context().newCDPSession(page);
  const box = await importBtn.boundingBox();
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  const recoveryBtn = page.getByRole('button', { name: /Import Recovery Phrase/i });
  await expect(recoveryBtn).toBeVisible({ timeout: 20_000 });
  const recoveryBox = await recoveryBtn.boundingBox();
  if (recoveryBox) {
    const x = recoveryBox.x + recoveryBox.width / 2;
    const y = recoveryBox.y + recoveryBox.height / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  const mnemonicInputs = page.locator('input, textarea');
  await expect(mnemonicInputs.first()).toBeVisible({ timeout: 15_000 });
  const inputCount = await mnemonicInputs.count();
  if (inputCount >= 12) {
    for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
      await mnemonicInputs.nth(i).fill(TEST_MNEMONIC_WORDS[i]);
    }
  } else {
    await mnemonicInputs.first().fill(TEST_MNEMONIC);
  }
  const confirmAfterMnemonic = page.getByRole('button', { name: /^import wallet$/i });
  await expect(confirmAfterMnemonic).toBeEnabled({ timeout: 15_000 });
  await confirmAfterMnemonic.click();

  // Wait for the result state; Phantom may replace the page.
  const ctx = page.context();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      const text = await p.locator('body').innerText().catch(() => '');
      if (/We found .* accounts? with activity/i.test(text)) { page = p; break; }
    }
    if (/We found .* accounts? with activity/i.test(await page.locator('body').innerText().catch(() => ''))) break;
    await new Promise(r => setTimeout(r, 500));
  }
  await page.waitForFunction(() => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], div'));
    const candidate = els.find(el => (el.textContent || '').trim() === 'Continue');
    if (!candidate) return false;
    if (candidate.getAttribute('aria-disabled') === 'true') return false;
    if ((candidate as HTMLElement).hasAttribute('disabled')) return false;
    if (parseFloat(getComputedStyle(candidate).opacity) < 0.7) return false;
    return true;
  }, undefined, { timeout: 45_000, polling: 500 });
  const importAccountsContinue = page.getByText('Continue', { exact: true }).first();
  const newCdp = await page.context().newCDPSession(page);
  const b = await importAccountsContinue.boundingBox();
  if (b) {
    const x = b.x + b.width / 2; const y = b.y + b.height / 2;
    await newCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await newCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await newCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  // Create a password screen opens on yet another page.
  const createPwDeadline = Date.now() + 60_000;
  let pwPage: Page | null = null;
  while (Date.now() < createPwDeadline) {
    for (const p of ctx.pages()) {
      const text = await p.locator('body').innerText().catch(() => '');
      if (/Create a password/i.test(text)) { pwPage = p; break; }
    }
    if (pwPage) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (pwPage) page = pwPage;

  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible({ timeout: 15_000 });
  await pwInputs.nth(0).fill(TEST_PASSWORD);
  await pwInputs.nth(1).fill(TEST_PASSWORD);

  // Reach UI hidden checkbox — native .click() via JS.
  await page.locator('[data-testid="onboarding-form-terms-of-service-checkbox"]')
    .first().waitFor({ state: 'attached', timeout: 10_000 });
  await page.evaluate(() => {
    const cb = document.querySelector('[data-testid="onboarding-form-terms-of-service-checkbox"]') as HTMLInputElement | null;
    cb?.click();
  });
  await expect(
    page.locator('[data-testid="onboarding-form-terms-of-service-checkbox"][aria-checked="true"]'),
  ).toBeAttached({ timeout: 5_000 });

  await page.waitForFunction(() => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], div'));
    const candidate = els.find(el => (el.textContent || '').trim() === 'Continue');
    if (!candidate) return false;
    if (candidate.getAttribute('aria-disabled') === 'true') return false;
    if ((candidate as HTMLElement).hasAttribute('disabled')) return false;
    if (parseFloat(getComputedStyle(candidate).opacity) < 0.7) return false;
    return true;
  }, undefined, { timeout: 30_000, polling: 500 });
  const pwContinue = page.getByText('Continue', { exact: true }).first();
  const pwCdp = await page.context().newCDPSession(page);
  const pwBox = await pwContinue.boundingBox();
  if (pwBox) {
    const x = pwBox.x + pwBox.width / 2; const y = pwBox.y + pwBox.height / 2;
    await pwCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await pwCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await pwCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes("you're good to go") || t.includes('get started')
      || t.includes('send') || t.includes('receive') || t.includes('balance');
  }, undefined, { timeout: 60_000, polling: 500 });

  // Best-effort Get Started click — unlikely to land, but harmless if not.
  const gsLocator = page.getByText('Get Started', { exact: true }).first();
  if (await gsLocator.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await page.bringToFront();
    const gsBox = await gsLocator.boundingBox();
    if (gsBox) {
      const cdp2 = await page.context().newCDPSession(page);
      const x = gsBox.x + gsBox.width / 2; const y = gsBox.y + gsBox.height / 2;
      await cdp2.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      await cdp2.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp2.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (el) {
          const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, isPrimary: true } as PointerEventInit;
          el.dispatchEvent(new PointerEvent('pointerdown', opts));
          el.dispatchEvent(new PointerEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
        }
      }, { x, y });
    }
  }
  await page.waitForFunction(
    () => !/You're good to go/i.test(document.body.innerText || ''),
    undefined, { timeout: 10_000, polling: 300 },
  ).catch(() => undefined);
}
