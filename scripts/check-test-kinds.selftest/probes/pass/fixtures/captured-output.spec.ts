// Captured from https://mempool.space/api/tx/aa on 2026-10-01.
export const capturedFrom = 'https://mempool.space/api/tx/aa';

it('keeps the captured source', () => {
  expect(capturedFrom).toContain('/api/tx/');
});
