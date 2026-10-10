// The deep link mirrors what cat21.space renders; see ordpool.space for the explorer.
describe('deep links as on cat21.space', () => {
  it('builds a mint link like ordpool.space does', () => {
    expect(link('https://regtest.local/cat/0')).toBe('https://regtest.local/cat/0');
  });
});
