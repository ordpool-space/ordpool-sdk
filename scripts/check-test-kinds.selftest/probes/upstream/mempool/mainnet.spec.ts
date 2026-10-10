it('loads mainnet', async () => {
  await page.waitForTimeout(1000);
  expect(await fetch('https://mempool.space/api/blocks')).toBeTruthy();
}, 30_000);
