import { classifyUtxoContent } from './utxo-content.classify.js';
import {
  catOutputFixture,
  cleanOutputFixture,
  inscribedOutputFixture,
  notIndexedOutputFixture,
  rareSatOutputFixture,
  runeOutputFixture,
} from './utxo-content.fixtures.js';

/**
 * The fixtures exist so consumers' mocks cannot drift from the classifier.
 * That only holds if something checks they still classify as their names
 * claim, so this is that check. It is the reason a future contract change
 * fails in this package rather than in three consumers' suites.
 */
describe('canonical /output fixtures classify the way their names claim', () => {

  it('cleanOutputFixture is indexed AND clean', () => {
    const { ord, cat21Ord } = cleanOutputFixture();
    const c = classifyUtxoContent(ord, cat21Ord);

    // Both halves matter: "clean" without "indexed" is the fail-open that
    // spent a real coin, and a fixture missing sat_ranges is how a consumer's
    // funding coin silently became unclassifiable.
    expect(c.indexed).toBe(true);
    expect(c.clean).toBe(true);
  });

  it.each([
    ['inscribedOutputFixture', inscribedOutputFixture, (c: ReturnType<typeof classifyUtxoContent>) => c.inscriptionIds.length],
    ['catOutputFixture', catOutputFixture, (c: ReturnType<typeof classifyUtxoContent>) => c.catIds.length],
    ['runeOutputFixture', runeOutputFixture, (c: ReturnType<typeof classifyUtxoContent>) => (c.runes === null ? 0 : 1)],
    ['rareSatOutputFixture', rareSatOutputFixture, (c: ReturnType<typeof classifyUtxoContent>) => (c.rareSat === null ? 0 : 1)],
  ])('%s is indexed, NOT clean, and carries its own asset', (_name, build, count) => {
    const { ord, cat21Ord } = (build as () => ReturnType<typeof cleanOutputFixture>)();
    const c = classifyUtxoContent(ord, cat21Ord);

    expect(c.indexed).toBe(true);
    expect(c.clean).toBe(false);
    // Names its OWN asset, so a guard spec's failure message points at the
    // right class instead of merely "not clean".
    expect(count(c)).toBeGreaterThan(0);
  });

  it('notIndexedOutputFixture is neither indexed nor clean, and names no asset', () => {
    const { ord, cat21Ord } = notIndexedOutputFixture();
    const c = classifyUtxoContent(ord, cat21Ord);

    expect(c.indexed).toBe(false);
    expect(c.clean).toBe(false);
    // The distinction a consumer must preserve: this is "no answer", not
    // "assets found". A port that maps it to has-assets is safe but wrong;
    // one that maps it to clean spends the coin.
    expect(c.inscriptionIds).toEqual([]);
    expect(c.catIds).toEqual([]);
    expect(c.runes).toBeNull();
    expect(c.rareSat).toBeNull();
  });
});
