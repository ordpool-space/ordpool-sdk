/**
 * @test-kind unit
 * Real:   classify
 * Faked:  fetch -> cleanOutputFixture (ordpool-sdk/core, captured)
 */
import { classify } from './classify';

it('classifies', () => {
  expect(classify(jest.fn())).toBe('clean');
});
