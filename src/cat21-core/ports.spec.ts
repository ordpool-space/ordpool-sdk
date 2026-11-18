/**
 * @test-kind unit
 * Real:   the UtxoAssetDetail and UtxoContent types
 * Faked:  nothing
 * Proves: `cats` and `catSat` are required on both shapes, so a scan port or a mapping that drops the cat numbers
 *         fails to compile instead of silently showing no number (cat21-wallet's classifyOutpointVerdict did, while
 *         the fields were optional)
 */
import { describe, expect, it } from '@jest/globals';

import { UtxoAssetDetail } from './ports.js';
import { UtxoContent } from '../cat21-mint/utxo-content.types.js';

describe('the cat fields are required', () => {
  it('a UtxoAssetDetail without cats or catSat does not compile', () => {
    // @ts-expect-error cats is required
    const withoutCats: UtxoAssetDetail = { inscriptionIds: [], runeNames: [], catIds: [], catSat: null, rareSat: null };
    // @ts-expect-error catSat is required
    const withoutCatSat: UtxoAssetDetail = { inscriptionIds: [], runeNames: [], catIds: [], cats: [], rareSat: null };

    expect([withoutCats.catIds, withoutCatSat.cats]).toEqual([[], []]);
  });

  it('a UtxoContent without cats does not compile', () => {
    // @ts-expect-error cats is required
    const content: UtxoContent = { outpoint: 'a:0', inscriptionIds: [], runes: null, catIds: [], catSat: null, rareSat: null };

    expect(content.catIds).toEqual([]);
  });
});
