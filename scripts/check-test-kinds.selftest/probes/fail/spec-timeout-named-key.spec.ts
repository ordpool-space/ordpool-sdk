test('shows the popup', async ({ page }) => {
  await expect(page.getByTestId('popup')).toBeVisible({ timeout: TIMEOUTS.popup });
});
