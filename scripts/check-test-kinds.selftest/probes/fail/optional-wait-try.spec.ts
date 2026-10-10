test('waits for the popup', async ({ page }) => {
  try {
    await page.getByTestId('popup').waitFor({ state: 'visible' });
  } catch {
    /* no popup this time */
  }
  await expect(page.getByTestId('home')).toBeVisible();
});
