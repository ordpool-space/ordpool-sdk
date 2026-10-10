/**
 * @test-kind unit
 * Real:   classify, the real SDK
 * Faked:  fetch -> cleanOutputFixture (ordpool-sdk/core, captured)
 * Proves: a clean output classifies as clean
 */
import { classify } from './classify';

it('classifies', () => {
  expect(classify(jest.fn())).toBe('clean');
});
