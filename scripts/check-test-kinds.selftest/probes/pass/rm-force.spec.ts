import { rmSync, mkdtempSync } from 'node:fs';

it('cleans up', () => {
  const dir = mkdtempSync('/tmp/x');
  rmSync(dir, { recursive: true, force: true });
  expect(exists(dir)).toBe(false);
});
