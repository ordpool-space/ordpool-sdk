import { describe, expect, it } from '@jest/globals';

import {
  CAT21_WALLET_POSITIONING,
  ORDPOOL_FAMILY,
  ordpoolFamilyMember,
} from './ordpool-family';

describe('ORDPOOL_FAMILY', () => {
  it('carries every member a footer has to render', () => {
    expect(ORDPOOL_FAMILY.map(m => m.key)).toEqual(['ordpool', 'cat21', 'cubes', 'wallet']);
  });

  it('gives each member a name, a url and a line', () => {
    for (const m of ORDPOOL_FAMILY) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.url).toMatch(/^https:\/\//);
      expect(m.line.length).toBeGreaterThan(0);
    }
  });

  it('keeps the maintainer wording exactly, signature capital included', () => {
    expect(ordpoolFamilyMember('ordpool').line).toBe('The best MEMEpool explorer on Bitcoin.');
    expect(ordpoolFamilyMember('cat21').line).toBe(
      'Everything CAT-21, a meme protocol from the Creator of Ordpool.',
    );
    expect(ordpoolFamilyMember('cubes').line).toBe(
      'Everything cubes, an art project from the Creator of Ordpool.',
    );
    expect(ordpoolFamilyMember('wallet').line).toBe(
      'A hot wallet for high frequency trading of CAT-21, made for AI agents and their humans.',
    );
  });

  it('never calls the project "ordpool" mid-sentence, which is the brand rule', () => {
    // Domains stay lowercase; the project as a subject is "Ordpool".
    for (const m of ORDPOOL_FAMILY) {
      expect(m.line).not.toMatch(/\bordpool\b/);
    }
  });

  it('is the SAME sentence the wallet uses to position itself, never a second one', () => {
    // If these ever diverge, the family footer and the wallet's own screen
    // describe one product in two voices, which is what hosting it here
    // exists to prevent.
    expect(CAT21_WALLET_POSITIONING).toBe(ordpoolFamilyMember('wallet').line);
  });

  it('throws on an unknown member rather than returning undefined into a template', () => {
    expect(() => ordpoolFamilyMember('nope' as 'wallet')).toThrow('Unknown Ordpool family member');
  });
});
