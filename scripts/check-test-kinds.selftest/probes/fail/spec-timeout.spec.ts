test('mints', async ({ page }) => {
  test.setTimeout(240_000);
  await expect(page.getByTestId('home')).toBeVisible();
});
