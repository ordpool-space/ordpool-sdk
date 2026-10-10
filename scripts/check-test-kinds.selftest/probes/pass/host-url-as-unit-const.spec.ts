// A unit spec builds a URL from a production base and never requests it: data, not a request.
const API = 'https://api.ordpool.space';

it('builds the url', () => {
  expect(txUrl(API, 'aa')).toBe('x');
});
