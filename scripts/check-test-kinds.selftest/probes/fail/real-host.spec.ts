const API = 'https://api.ordpool.space';

it('builds the url', () => {
  expect(txUrl(API, 'aa')).toBe('x');
});
