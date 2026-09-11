import { describe, expect, it } from '@jest/globals';

import { singleAddressCaveat } from '../wallet/wallet-capabilities';
import { COIN_CHECK_PROMISE } from './coin-check-promise';
import {
  CAT21_WALLET_POSITIONING,
  ORDPOOL_FAMILY,
  ORDPOOL_FAMILY_HEADING,
  ordpoolFamilyLede,
  CAT21_LORE_POINTER,
  ordpoolFamilyMember,
} from './ordpool-family';

describe('ordpoolFamilyLede', () => {
  it(`names what THIS site renders, in the maintainer's words`, () => {
    expect(ordpoolFamilyLede('ordpool')).toBe(
      'Sometimes Bitcoin is hard money. Sometimes Bitcoin is a JPEG.',
    );
    expect(ordpoolFamilyLede('cat21')).toBe(
      'Sometimes Bitcoin is hard money. Sometimes Bitcoin is a pixelated cat.',
    );
    expect(ordpoolFamilyLede('cubes')).toBe(
      'Sometimes Bitcoin is hard money. Sometimes Bitcoin is an artsy rotating cube.',
    );
  });

  it('keeps the mission half identical everywhere, varying only the tail', () => {
    const MISSION = 'Sometimes Bitcoin is hard money. ';
    const tails = (['ordpool', 'cat21', 'cubes'] as const).map(
      s => ordpoolFamilyLede(s).slice(MISSION.length),
    );
    for (const s of ['ordpool', 'cat21', 'cubes'] as const) {
      expect(ordpoolFamilyLede(s).startsWith(MISSION)).toBe(true);
    }
    expect(new Set(tails).size).toBe(3);
  });

  it('carries NO safety claim, because a footer is not the place for one', () => {
    // Removed deliberately: it frightened every reader to warn the few who
    // needed it. The claim lives in singleAddressCaveat, at the action.
    for (const s of ['ordpool', 'cat21', 'cubes'] as const) {
      expect(ordpoolFamilyLede(s)).not.toContain(COIN_CHECK_PROMISE);
      // NOT a bare 'coin' check: 'Bitcoin' contains it, which is how the
      // first version of this assertion failed on correct copy.
      expect(ordpoolFamilyLede(s).toLowerCase()).not.toContain('spends it');
      expect(ordpoolFamilyLede(s).toLowerCase()).not.toContain('carrying');
    }
    // ...and it is still there, where it belongs.
    expect(singleAddressCaveat()).toContain(COIN_CHECK_PROMISE);
  });

  it('capitalises the project as a proper noun in the heading', () => {
    expect(ORDPOOL_FAMILY_HEADING).toBe('The Ordpool family');
    expect(ORDPOOL_FAMILY_HEADING).not.toContain('ordpool');
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
