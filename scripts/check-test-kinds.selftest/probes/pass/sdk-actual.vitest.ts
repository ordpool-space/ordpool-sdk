/**
 * @test-kind unit
 * Real:   ordpool-sdk except its network calls
 * Faked:  fetchOutput -> cleanOutputFixture (ordpool-sdk/core, captured)
 * Proves: vitest's importOriginal spread is the allowed form
 */
vi.mock('ordpool-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ordpool-sdk')>()),
  fetchOutput: vi.fn(),
}));

it('reads', () => {
  expect(read()).toBe(1);
});
