import { describe, expect, it } from '@jest/globals';

import { singleAddressCaveat } from '../wallet/wallet-capabilities';
import { COIN_CHECK_PROMISE } from './coin-check-promise';
import * as family from './ordpool-family';
import {
  CAT21_WALLET_POSITIONING,
  ORDPOOL_FAMILY,
  ORDPOOL_FAMILY_HEADING,
  CAT21_LORE_POINTER,
  ordpoolFamilyMember,
} from './ordpool-family';

describe('the family module hosts no per-site lede', () => {
  it('exports no lede helper, because a site\'s tagline is its own repo\'s copy', () => {
    // The heading and the member lines describe EVERY member, so one copy of
    // them keeps the family consistent. A site's own tagline describes only
    // itself, so hosting it put the SDK in the way of a repo editing its own
    // voice and bought nothing.
    const mod = family as Record<string, unknown>;
    expect(mod.ordpoolFamilyLede).toBeUndefined();
    expect(mod.ORDPOOL_FAMILY_LEDE).toBeUndefined();
  });

  it('still hosts what every site prints about every member', () => {
    expect(ORDPOOL_FAMILY_HEADING).toBe('The Ordpool family');
    expect(ORDPOOL_FAMILY).toHaveLength(4);
  });

  it('keeps the safety claim out of the footer and in the note', () => {
    // Where it went when it was removed from the lede, and where it stays.
    expect(singleAddressCaveat()).toContain(COIN_CHECK_PROMISE);
  });

  it('points the wallet at the lore, since it has no footer to carry a lede', () => {
    expect(CAT21_LORE_POINTER).toBe('See cat21.space for the whole cat lore.');
  });
});

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
    expect(ordpoolFamilyMember('ordpool').line).toBe('See inside every Bitcoin block.');
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
