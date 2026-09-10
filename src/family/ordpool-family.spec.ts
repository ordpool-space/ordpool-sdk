import { describe, expect, it } from '@jest/globals';

import { singleAddressCaveat } from '../wallet/wallet-capabilities';
import { COIN_CHECK_PROMISE } from './coin-check-promise';
import {
  CAT21_WALLET_POSITIONING,
  ORDPOOL_FAMILY,
  ORDPOOL_FAMILY_HEADING,
  ORDPOOL_FAMILY_LEDE,
  ordpoolFamilyMember,
} from './ordpool-family';

describe('ORDPOOL_FAMILY_LEDE', () => {
  it('opens with the mission line, which is what makes it bold', () => {
    expect(ORDPOOL_FAMILY_LEDE).toContain(
      'Sometimes Bitcoin is hard money. Sometimes Bitcoin is a JPEG.',
    );
  });

  it('makes the SAME promise as the single-address note, word for word', () => {
    // The footer and the note are two places a reader meets the same claim.
    // If these drift, the family advertises a property its own warning
    // describes differently, which reads worse than either saying nothing.
    //
    // Asserted through the shared constant rather than two hand-typed
    // strings: a version of this test with the wording written out twice
    // passed while the two sentences actually differed.
    expect(ORDPOOL_FAMILY_LEDE).toContain(COIN_CHECK_PROMISE);
    expect(singleAddressCaveat()).toContain(COIN_CHECK_PROMISE);
    expect(singleAddressCaveat('cubes')).toContain(COIN_CHECK_PROMISE);
  });

  it('capitalises the project as a proper noun in the heading', () => {
    expect(ORDPOOL_FAMILY_HEADING).toBe('The Ordpool family');
    expect(ORDPOOL_FAMILY_HEADING).not.toContain('ordpool');
  });

  it('names no count, so a fifth member does not falsify it', () => {
    expect(ORDPOOL_FAMILY_LEDE).not.toMatch(/\b(two|three|four|five|\d+)\b/i);
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
