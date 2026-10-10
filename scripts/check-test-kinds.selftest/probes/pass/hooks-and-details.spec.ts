test.beforeAll(async () => {
  await boot();
});

test('tagged', { tag: '@regtest' }, async () => {
  expect(await boot()).toBe(true);
});

it('plain', async () => {
  expect(await boot()).toBe(true);
});
