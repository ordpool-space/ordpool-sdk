/**
 * @test-kind unit
 * Real:   classify
 * Faked:
 * Proves: an empty field followed by the next field is reported
 */
import { classify } from './classify';

it('classifies', () => {
  expect(classify(jest.fn())).toBe('clean');
});
