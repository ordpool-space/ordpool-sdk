// A unit test of a URL rewriter: the production URL is the input, nothing requests it.
it('rewrites an ordinals.com content link', () => {
  expect(rewrite('https://ordinals.com/content/abc')).toBe('/content/abc');
});
