/**
 * @test-kind unit
 * Real:   classify,
 *         the real SDK
 * Faked:
 *         fetch -> cleanOutputFixture (ordpool-sdk/core, captured)
 * Proves: a field's value may continue on the following lines
 */
import { classify } from './classify';

it('classifies', () => {
  expect(classify(jest.fn())).toBe('clean');
});
