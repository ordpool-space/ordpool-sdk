it('surfaces the click error', async () => {
  const err = await page.getByTestId('gone').click().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  await page.getByTestId('x').click().catch((e) => {
    throw new Error(`click failed: ${String(e)}`);
  });
  const text = await page.locator('body').innerText().catch(() => '');
  expect(text).toBe('');
});
