/**
 * @test-kind wallet
 * Real:   Xverse 2.3.2 (.crx), SDK harness page, regtest stack
 * Faked:  nothing
 * Proves: the harness connects
 */
import { test, expect } from '@playwright/test';

test('connects', async ({ page }) => {
  await expect(page.getByTestId('connected')).toBeVisible();
});
