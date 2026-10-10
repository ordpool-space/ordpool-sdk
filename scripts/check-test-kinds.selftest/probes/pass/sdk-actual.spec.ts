/**
 * @test-kind unit
 * Real:   ordpool-sdk/core except its network calls
 * Faked:  fetchOutput -> cleanOutputFixture (ordpool-sdk/core, captured)
 * Proves: the actual SDK module spread in is the allowed form
 */
jest.mock('ordpool-sdk/core', () => ({
  ...jest.requireActual('ordpool-sdk/core'),
  fetchOutput: jest.fn(),
}));

it('reads', () => {
  expect(read()).toBe(1);
});
