// A production host as data, not as an address: the inscription body carries a
// brand comment, and a record names the site that minted it. Neither reaches anything.
it('marks the cube body with its site', () => {
  const html = '<html><!--cubes.haushoppe.art--></html>';
  const record = { minted_by: 'ordpool.space' };
  expect(html).toContain('cubes.haushoppe.art');
  expect(record.minted_by).toBe('ordpool.space');
});
