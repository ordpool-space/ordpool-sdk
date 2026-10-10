test('closes the promo', async ({ page }) => {
  await page.getByTestId('not-now').click({ force: true });
  await expect(page.getByTestId('home')).toBeVisible();
});
