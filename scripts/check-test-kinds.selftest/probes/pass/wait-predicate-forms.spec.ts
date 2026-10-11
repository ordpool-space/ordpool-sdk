test('waits on a synchronous predicate and polls an async answer', async ({ page }) => {
  // A comment naming waitForFunction(async () => ...) is not code.
  await page.waitForFunction(() => (window as unknown as { ready?: true }).ready === true);
  await page.waitForFunction(function isReady() { return document.readyState === 'complete'; });
  await expect.poll(() => page.evaluate(async () => {
    const w = (window as unknown as { wallet: { ready(): Promise<boolean> } }).wallet;
    return w.ready();
  })).toBe(true);
  const label = 'waitForFunction(async () => true)';
  expect(label).toContain('async');
});
