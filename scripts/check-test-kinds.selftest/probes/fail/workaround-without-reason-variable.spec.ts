test('submits', async ({ page }) => {
  await workaroundWaitForTimeout(page, 300, REASON_DEFINED_ELSEWHERE_LONG_ENOUGH);
  await expect(page.getByTestId('done')).toBeVisible();
});
