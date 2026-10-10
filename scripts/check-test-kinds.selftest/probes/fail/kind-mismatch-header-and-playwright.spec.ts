/**
 * @test-kind e2e
 * Real:   built frontend, regtest stack
 * Faked:  nothing
 * Proves: a header kind that disagrees with the name is one finding, even with a Playwright import
 */
import { test, expect } from '@playwright/test';

test('loads', async ({ page }) => {
  await expect(page.getByTestId('home')).toBeVisible();
});
