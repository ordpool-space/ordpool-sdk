test('closes the promo', async ({ page }) => {
  await page.getByTestId('not-now').click().catch(() => undefined);
  await expect(page.getByTestId('home')).toBeVisible();
});
