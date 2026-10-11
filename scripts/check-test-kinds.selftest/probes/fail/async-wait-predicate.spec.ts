test('waits for the wallet to answer', async ({ page }) => {
  await page.waitForFunction(async () => {
    const w = (window as unknown as { wallet: { ready(): Promise<boolean> } }).wallet;
    return await w.ready();
  });
  await expect(page.getByTestId('connected')).toBeVisible();
});
