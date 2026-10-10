test('imports', async ({ page }) => {
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="import"]') as HTMLElement | null;
    btn?.click();
  });
  await expect(page.getByTestId('home')).toBeVisible();
});
