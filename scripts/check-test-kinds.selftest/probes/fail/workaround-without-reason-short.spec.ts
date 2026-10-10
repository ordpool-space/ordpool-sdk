test('submits', async ({ page }) => {
  await workaroundWaitForTimeout(page, 300, 'flaky');
  await expect(page.getByTestId('done')).toBeVisible();
});
