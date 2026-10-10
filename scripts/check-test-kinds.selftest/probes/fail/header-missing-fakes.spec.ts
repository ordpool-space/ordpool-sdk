import { classify } from './classify';

it('classifies', () => {
  const fetchFn = jest.fn();
  expect(classify(fetchFn)).toBe('clean');
});
