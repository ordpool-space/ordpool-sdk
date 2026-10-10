import { add } from './add';

it('a non-kind word inside a hyphenated base name is a subject, not a kind', () => {
  expect(add(1, 2)).toBe(3);
});
