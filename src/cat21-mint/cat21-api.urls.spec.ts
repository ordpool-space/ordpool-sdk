import { describe, expect, it } from '@jest/globals';

import {
  buildCatImageUrl,
  buildLatestCatNumbersUrl,
  buildStatusUrl,
} from './cat21-api.urls';

const base = 'https://api.cat21.test';

describe('cat21-api URL builders', () => {

  it('builds the status URL', () => {
    expect(buildStatusUrl(base)).toBe(`${base}/api/status`);
  });

  it('builds the latest-cat-numbers URL with the requested page size', () => {
    expect(buildLatestCatNumbersUrl(base, 1)).toBe(`${base}/api/cats/numbers/1/1`);
    expect(buildLatestCatNumbersUrl(base, 50)).toBe(`${base}/api/cats/numbers/50/1`);
  });

  it('builds the cat image URL', () => {
    expect(buildCatImageUrl(base, 0)).toBe(`${base}/api/cat/0/image.webp`);
    expect(buildCatImageUrl(base, 21)).toBe(`${base}/api/cat/21/image.webp`);
    expect(buildCatImageUrl(base, 999999)).toBe(`${base}/api/cat/999999/image.webp`);
  });

  it('preserves a trailing-slash-free base URL', () => {
    expect(buildCatImageUrl('https://api.cat21.test', 0)).toBe('https://api.cat21.test/api/cat/0/image.webp');
  });
});
