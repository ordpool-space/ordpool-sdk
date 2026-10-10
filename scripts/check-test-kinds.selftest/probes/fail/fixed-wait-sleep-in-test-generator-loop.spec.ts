for (const wallet of ['xverse', 'unisat']) {
  test(`connects ${wallet}`, async ({ page }) => {
    await sleep(1_000);
    await expect(page.getByTestId(wallet)).toBeVisible();
  });
}
