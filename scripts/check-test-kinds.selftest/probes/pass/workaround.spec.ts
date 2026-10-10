test('submits after the debounce', async ({ page }) => {
  await page.getByTestId('amount').fill('546');
  await workaroundWaitForTimeout(page, 300, 'wallet popup debounceTime(300) before submit');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('done')).toBeVisible();
});
