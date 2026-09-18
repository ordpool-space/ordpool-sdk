import { assertDirtyCoinIsBestFit, PlacementUtxo } from './dirty-coin-placement';

/**
 * Every rejection branch here is a way a dirty-coin spec passes while proving
 * nothing, so each one must be reachable by a test. A placement checker whose
 * branches never run is the same defect it exists to catch.
 */
const coin = (marker: string, value: number): PlacementUtxo => ({
  txid: marker.repeat(64).slice(0, 64),
  vout: 0,
  value,
});
const at = (u: PlacementUtxo) => `${u.txid}:${u.vout}`;

const REQUIREMENT = 10_000;

describe('assertDirtyCoinIsBestFit', () => {
  it('accepts the one shape that proves something: dirty just above, clean well above', () => {
    const dirty = coin('a', 12_000);
    const clean = coin('b', 45_000);
    expect(() => assertDirtyCoinIsBestFit([dirty, clean], at(dirty), REQUIREMENT)).not.toThrow();
  });

  it('rejects a dirty coin that does not cover, because selection reaches past it', () => {
    const dirty = coin('a', 900);
    const clean = coin('b', 45_000);
    expect(() => assertDirtyCoinIsBestFit([dirty, clean], at(dirty), REQUIREMENT))
      .toThrow(/reaches PAST it/);
  });

  it('rejects a dirty coin larger than the clean one, which best-fit never takes', () => {
    const dirty = coin('a', 45_000);
    const clean = coin('b', 12_000);
    expect(() => assertDirtyCoinIsBestFit([dirty, clean], at(dirty), REQUIREMENT))
      .toThrow(/smallest covering coin is/);
  });

  it('rejects a pool with no clean alternative, which proves FLAGS not AVOIDS', () => {
    const dirty = coin('a', 12_000);
    expect(() => assertDirtyCoinIsBestFit([dirty], at(dirty), REQUIREMENT))
      .toThrow(/no clean alternative to steer to/);
  });

  it('rejects an outpoint that never made it into the pool', () => {
    const clean = coin('b', 45_000);
    expect(() => assertDirtyCoinIsBestFit([clean], 'deadbeef:0', REQUIREMENT))
      .toThrow(/not in the pool at all/);
  });
});

describe('assertDirtyCoinIsBestFit and the change-headroom target', () => {
  // Reproduces a real matrix run: four rungs above a 700-sat requirement, the
  // bottom one below the ~1277 headroom target. Three cells red under the
  // mutation and the fourth passed, which looked like the fourth asset class
  // being protected by something and was actually selection never considering
  // that coin.
  const REQUIREMENT = 700;
  const HEADROOM = 1_277;

  it('rejects a coin that covers the requirement but not the headroom target', () => {
    const dirty = coin('a', 1_200);
    const others = [coin('b', 2_200), coin('c', 100_000)];
    expect(() => assertDirtyCoinIsBestFit([dirty, ...others], at(dirty), REQUIREMENT, HEADROOM))
      .toThrow(/not the 1277 change-headroom target/);
  });

  it('accepts the same coin when NOTHING clears the headroom target', () => {
    // With no headroom candidate the flow falls back to the covering set, so a
    // sub-headroom coin is genuinely what selection would take.
    const dirty = coin('a', 800);
    const clean = coin('b', 1_100);
    expect(() => assertDirtyCoinIsBestFit([dirty, clean], at(dirty), REQUIREMENT, HEADROOM))
      .not.toThrow();
  });

  it('accepts a coin that clears the headroom target and is smallest among those', () => {
    const dirty = coin('a', 1_400);
    const clean = coin('b', 100_000);
    expect(() => assertDirtyCoinIsBestFit([dirty, clean], at(dirty), REQUIREMENT, HEADROOM))
      .not.toThrow();
  });

  it('still compares smallest-first WITHIN the headroom set, not across the whole pool', () => {
    // A sub-headroom coin is smaller than the dirty one but irrelevant: it is
    // not selectable, so it must not make the dirty coin look non-smallest.
    const dirty = coin('a', 1_400);
    const tiny = coin('b', 900);
    const clean = coin('c', 100_000);
    expect(() => assertDirtyCoinIsBestFit([dirty, tiny, clean], at(dirty), REQUIREMENT, HEADROOM))
      .not.toThrow();
  });

  it('ignores a headroom target that is not above the requirement', () => {
    const dirty = coin('a', 800);
    const clean = coin('b', 100_000);
    expect(() => assertDirtyCoinIsBestFit([dirty, clean], at(dirty), REQUIREMENT, 500)).not.toThrow();
  });
});
