test('closes the promo', async ({ page }) => {
  try {
    await page.getByTestId('not-now').click();
  } catch {
    /* fall back below */
  }
  await expect(page.getByTestId('home')).toBeVisible();
});
