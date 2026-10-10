test.describe.configure({ mode: 'serial', retries: 2 });

test('loads', async ({ page }) => {
  await expect(page.getByTestId('home')).toBeVisible();
});
