// A unit test that requests production.
it('reads a transaction', async () => {
  const res = await fetch('https://api.ordpool.space/api/tx/aa');
  expect(res.status).toBe(200);
});
