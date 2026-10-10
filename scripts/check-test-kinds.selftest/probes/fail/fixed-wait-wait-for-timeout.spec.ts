test('waits', async ({ page }) => {
  await page.waitForTimeout(500);
  await expect(page.getByTestId('home')).toBeVisible();
});
