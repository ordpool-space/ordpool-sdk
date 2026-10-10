it('settles', async () => {
  const o = start();
  await new Promise((r) => setTimeout(r, 300));
  expect(o.count).toBe(1);
});
