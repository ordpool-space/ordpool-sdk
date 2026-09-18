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
