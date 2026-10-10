test('dismisses the promo', async ({ page }) => {
  if (await isVisibleWithin(page.getByTestId('promo'), PROMO)) {
    await page.getByTestId('promo-close').click();
  }
  await expect(page.getByTestId('home')).toBeVisible();
});
