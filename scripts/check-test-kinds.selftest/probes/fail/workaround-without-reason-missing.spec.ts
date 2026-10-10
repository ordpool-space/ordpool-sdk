test('submits', async ({ page }) => {
  await workaroundWaitForTimeout(page, 300);
  await expect(page.getByTestId('done')).toBeVisible();
});
