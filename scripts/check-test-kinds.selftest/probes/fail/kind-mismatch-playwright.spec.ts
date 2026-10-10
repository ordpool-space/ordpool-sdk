import { test, expect } from '@playwright/test';

test('loads', async ({ page }) => {
  await expect(page.getByTestId('home')).toBeVisible();
});
