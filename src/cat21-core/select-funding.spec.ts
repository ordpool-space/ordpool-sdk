import { describe, expect, it } from '@jest/globals';

import { ContentScanPort, UtxoClassification } from './ports.js';
import { resolveFundingPick, selectFunding } from './select-funding.js';
import { expertRequiredCause, expertRequiredMessage } from '../cat21-fee/funding-safety.js';

// A plain NODE unit test — no jsdom. That the framework-agnostic
// core selection is testable this way is the whole point of the migration.

const u = (id: string, value: number, vout = 0) => ({
  txid: id.repeat(64).slice(0, 64),
  vout,
  value,
});
const op = (x: { txid: string; vout: number }) => `${x.txid}:${x.vout}`;

/**
 * A `has-assets` verdict that NAMES what it found. Only such a coin may stand
 * behind a notice; a bare `'has-assets'` blocks on every topology.
 */
const named: UtxoClassification = {
  verdict: 'has-assets',
  assets: { inscriptionIds: ['abc123i0'], runeNames: [], catIds: [], rareSat: null },
};

/** Fake ContentScanPort: map outpoint -> verdict, or 'reject' to fail the scan. */
function fakeScan(verdicts: Record<string, UtxoClassification | 'reject'>): {
  port: ContentScanPort;
  scanned: string[];
} {
  const scanned: string[] = [];
  const port: ContentScanPort = {
    classify: async (outpoint) => {
      scanned.push(outpoint);
      const v = verdicts[outpoint] ?? 'clean';
      if (v === 'reject') throw new Error('scan failed');
      return v;
    },
  };
  return { port, scanned };
}

describe('selectFunding (framework-agnostic content-checked selection)', () => {
  it('AUTO: a clean covering coin is auto-selected (best-fit clean)', async () => {
    const utxos = [u('a', 50_000), u('b', 3_000)];
    const { port } = fakeScan({ [op(utxos[0])]: 'clean', [op(utxos[1])]: 'clean' });

    const rec = await selectFunding(utxos, 2_000, port);

    expect(rec.status).toBe('auto');
    expect(rec.recommended?.value).toBe(3_000); // smallest covering clean
  });

  it('force-scans every COVERING candidate regardless of size, skips non-covering', async () => {
    const utxos = [u('a', 5_000_000), u('b', 100)];
    const { port, scanned } = fakeScan({ [op(utxos[0])]: 'clean' });

    await selectFunding(utxos, 2_000, port);

    expect(scanned).toContain(op(utxos[0])); // the large covering coin WAS scanned
    expect(scanned).not.toContain(op(utxos[1])); // the non-covering coin was not
  });

  it('EXPERT-REQUIRED: only an asset coin covers -> recommend best-fit, flag it', async () => {
    const utxos = [u('a', 50_000)];
    const { port } = fakeScan({ [op(utxos[0])]: 'has-assets' });

    const rec = await selectFunding(utxos, 2_000, port);

    expect(rec.status).toBe('expert-required');
    expect(rec.recommended?.value).toBe(50_000);
    expect(rec.recommended?.bucket).toBe('assets');
  });

  it('never auto-spends the tighter ASSET coin when a clean coin also covers', async () => {
    const utxos = [u('a', 2_500), u('b', 40_000)]; // 2_500 is the tightest fit but carries assets
    const { port } = fakeScan({ [op(utxos[0])]: 'has-assets', [op(utxos[1])]: 'clean' });

    const rec = await selectFunding(utxos, 2_000, port);

    expect(rec.status).toBe('auto');
    expect(rec.recommended?.value).toBe(40_000);
    expect(rec.recommended?.bucket).toBe('clean');
  });

  it('a covering coin whose scan FAILS becomes `failed`, never auto-spent', async () => {
    const utxos = [u('a', 50_000)];
    const { port } = fakeScan({ [op(utxos[0])]: 'reject' });

    const rec = await selectFunding(utxos, 2_000, port);

    expect(rec.status).toBe('expert-required'); // failed-only covering => not auto
    expect(rec.recommended?.bucket).toBe('failed');
  });

  it('INSUFFICIENT when nothing covers; no scans triggered', async () => {
    const utxos = [u('a', 500), u('b', 1_000)];
    const { port, scanned } = fakeScan({});

    const rec = await selectFunding(utxos, 2_000, port);

    expect(rec.status).toBe('insufficient');
    expect(scanned.length).toBe(0);
  });

  it('a non-positive target -> insufficient, no scans', async () => {
    const utxos = [u('a', 50_000)];
    const { port, scanned } = fakeScan({});

    const rec = await selectFunding(utxos, 0, port);

    expect(rec.status).toBe('insufficient');
    expect(scanned.length).toBe(0);
  });
});

describe('the wallet topology decides whether a dirty-only wallet proceeds or blocks', () => {
  // The same pool, the same risk, two wallets. Only the obstruction differs.
  const dirtyOnly = [u('a', 200), u('b', 9_000)];
  const verdicts = { [op(u('b', 9_000))]: named };

  it('a separate-payment-address wallet PROCEEDS on the dirty coin, with a notice', async () => {
    const { port } = fakeScan(verdicts);
    const rec = await selectFunding(dirtyOnly, 2_000, port, undefined, 'separate-payment-address');
    expect(rec.status).toBe('asset-notice');
    // The half that makes it a notice and not a wall: a coin comes back.
    expect(resolveFundingPick(rec, 2_000)?.value).toBe(9_000);
  });

  it('a one-address wallet BLOCKS until the user overrides in expert mode', async () => {
    const { port } = fakeScan(verdicts);
    const rec = await selectFunding(dirtyOnly, 2_000, port, undefined, 'one-address-for-everything');
    expect(rec.status).toBe('expert-required');
    expect(resolveFundingPick(rec, 2_000)).toBeNull();
  });

  it('the one-address block is lifted by an EXPLICIT expert-mode pick', async () => {
    const { port } = fakeScan(verdicts);
    const rec = await selectFunding(dirtyOnly, 2_000, port, undefined, 'one-address-for-everything');
    const chosen = resolveFundingPick(rec, 2_000, { txid: u('b', 9_000).txid, vout: 0 });
    // They were shown what sits on it and chose it anyway. Their call.
    expect(chosen?.value).toBe(9_000);
    expect(chosen?.bucket).toBe('assets');
  });

  it('omitting the topology blocks, so an un-migrated caller over-blocks', async () => {
    const { port } = fakeScan(verdicts);
    const rec = await selectFunding(dirtyOnly, 2_000, port);
    expect(rec.status).toBe('expert-required');
    expect(resolveFundingPick(rec, 2_000)).toBeNull();
  });

  it('a clean coin still wins silently on either wallet', async () => {
    const pool = [u('c', 10_000), u('b', 9_000)];
    for (const topology of ['separate-payment-address', 'one-address-for-everything'] as const) {
      const { port } = fakeScan(verdicts);
      const rec = await selectFunding(pool, 2_000, port, undefined, topology);
      expect(rec.status).toBe('auto');
      expect(resolveFundingPick(rec, 2_000)?.value).toBe(10_000);
    }
  });

  it('never proceeds while a covering coin is still being scanned', async () => {
    const { port } = fakeScan({ [op(u('b', 9_000))]: named, [op(u('d', 20_000))]: 'reject' });
    const rec = await selectFunding(
      [u('b', 9_000), u('d', 20_000)], 2_000, port, undefined, 'separate-payment-address',
    );
    // A failed scan is unknown content, never clean: it may be recommended but
    // it is not silently auto-spent on a clean path.
    expect(rec.status).toBe('asset-notice');
    expect(rec.candidates.find((c) => c.value === 20_000)?.bucket).toBe('failed');
  });

  it('a separate-payment-address wallet BLOCKS when the only covering coin failed its scan', async () => {
    const failing = u('e', 20_000);
    const { port } = fakeScan({ [op(failing)]: 'reject' });
    const rec = await selectFunding(
      [u('a', 200), failing], 2_000, port, undefined, 'separate-payment-address',
    );
    expect(rec.status).toBe('expert-required');
    expect(rec.recommended?.value).toBe(20_000);
    expect(rec.recommended?.bucket).toBe('failed');
    // No coin is handed to a flow that may proceed: content unknown.
    expect(resolveFundingPick(rec, 2_000)).toBeNull();
    // An explicit expert-mode pick of that coin is still the user's call.
    expect(resolveFundingPick(rec, 2_000, { txid: failing.txid, vout: 0 })?.bucket).toBe('failed');
  });

  it('a failed coin that fits tighter never displaces the named asset coin behind a notice', async () => {
    const failing = u('f', 3_000);
    const dirty = u('b', 9_000);
    const { port } = fakeScan({ [op(failing)]: 'reject', [op(dirty)]: named });
    const rec = await selectFunding(
      [failing, dirty], 2_000, port, undefined, 'separate-payment-address',
    );
    expect(rec.status).toBe('asset-notice');
    expect(resolveFundingPick(rec, 2_000)?.value).toBe(9_000);
    expect(resolveFundingPick(rec, 2_000)?.bucket).toBe('assets');
  });
});

describe('the recommendation names what it found, so an API caller can decide like a person', () => {
  // A screen and an API are the same decision. Someone looking at a panel is
  // told WHICH inscription and WHICH cat sit on the coin; an agent choosing
  // over an API needs the same facts, or it is being asked to consent to a
  // loss it cannot see.
  const detail = {
    inscriptionIds: ['abc123i0'],
    runeNames: ['UNCOMMON•GOODS'],
    catIds: ['def456i0'],
    rareSat: { sat: '1857900000000000', block: 371, rarity: 'uncommon' },
  };

  const detailPort = (dirty: { txid: string; vout: number }) => ({
    classify: async (outpoint: string) =>
      outpoint === `${dirty.txid}:${dirty.vout}`
        ? ({ verdict: 'has-assets' as const, assets: detail })
        : ('clean' as const),
  });

  it('carries the asset detail onto the recommended coin', async () => {
    const dirty = u('b', 9_000);
    const rec = await selectFunding(
      [u('a', 200), dirty], 2_000, detailPort(dirty), undefined, 'separate-payment-address',
    );
    expect(rec.status).toBe('asset-notice');
    expect(rec.recommended?.assets).toEqual(detail);
    // Named, not merely flagged: every class is individually reachable.
    expect(rec.recommended?.assets?.inscriptionIds).toEqual(['abc123i0']);
    expect(rec.recommended?.assets?.catIds).toEqual(['def456i0']);
    expect(rec.recommended?.assets?.runeNames).toEqual(['UNCOMMON•GOODS']);
    expect(rec.recommended?.assets?.rareSat?.rarity).toBe('uncommon');
  });

  it('carries it on a BLOCKED recommendation too, which is what a picker renders', async () => {
    const dirty = u('b', 9_000);
    const rec = await selectFunding(
      [u('a', 200), dirty], 2_000, detailPort(dirty), undefined, 'one-address-for-everything',
    );
    expect(rec.status).toBe('expert-required');
    // No coin is handed over, but the user (or agent) must still be told what
    // they would be spending before they can override.
    expect(rec.recommended?.assets).toEqual(detail);
  });

  it('a port that reports only a bare verdict BLOCKS, because nothing can be named', async () => {
    // A notice that does not say what is on the coin is not a notice, so a
    // bare `has-assets` cannot be what enables the spend.
    const dirty = u('b', 9_000);
    const { port } = fakeScan({ [op(dirty)]: 'has-assets' });
    const rec = await selectFunding(
      [u('a', 200), dirty], 2_000, port, undefined, 'separate-payment-address',
    );
    expect(rec.status).toBe('expert-required');
    expect(rec.recommended?.value).toBe(9_000);
    expect(rec.recommended?.bucket).toBe('assets');
    expect(rec.recommended?.assets).toBeUndefined();
    expect(expertRequiredCause(rec)).toBe('unnamed-assets');
    expect(resolveFundingPick(rec, 2_000)).toBeNull();
  });

  it('the object verdict without a detail blocks the same way as the bare string', async () => {
    const dirty = u('b', 9_000);
    const { port } = fakeScan({ [op(dirty)]: { verdict: 'has-assets' } });
    const rec = await selectFunding(
      [u('a', 200), dirty], 2_000, port, undefined, 'separate-payment-address',
    );
    expect(rec.status).toBe('expert-required');
    expect(expertRequiredCause(rec)).toBe('unnamed-assets');
    expect(resolveFundingPick(rec, 2_000)).toBeNull();
  });

  it('an EMPTY detail (arrays empty, no rare sat) counts as unnamed and blocks', async () => {
    const empty = { inscriptionIds: [], runeNames: [], catIds: [], rareSat: null };
    const dirty = u('b', 9_000);
    const { port } = fakeScan({ [op(dirty)]: { verdict: 'has-assets', assets: empty } });
    const rec = await selectFunding(
      [u('a', 200), dirty], 2_000, port, undefined, 'separate-payment-address',
    );
    expect(rec.status).toBe('expert-required');
    // The detail travels as reported; it is the policy that reads it as unnamed.
    expect(rec.recommended?.assets).toEqual(empty);
    expect(expertRequiredCause(rec)).toBe('unnamed-assets');
    expect(expertRequiredMessage(rec)).toBe(
      'Select a funding UTXO (the covering coins carry assets the scan could not name)',
    );
  });

  it('a bare verdict also blocks on a one-address wallet, with the unnamed cause', async () => {
    const dirty = u('b', 9_000);
    const { port } = fakeScan({ [op(dirty)]: 'has-assets' });
    const rec = await selectFunding(
      [u('a', 200), dirty], 2_000, port, undefined, 'one-address-for-everything',
    );
    expect(rec.status).toBe('expert-required');
    expect(expertRequiredCause(rec)).toBe('unnamed-assets');
  });

  it('a NAMED coin wins over a tighter bare-verdict coin and stands behind the notice', async () => {
    // The bare 3_000 is the best fit by value; only the 9_000 can be named.
    const bare = u('n', 3_000);
    const namedCoin = u('b', 9_000);
    const { port } = fakeScan({ [op(bare)]: 'has-assets', [op(namedCoin)]: named });
    const rec = await selectFunding(
      [bare, namedCoin], 2_000, port, undefined, 'separate-payment-address',
    );
    expect(rec.status).toBe('asset-notice');
    expect(rec.recommended?.value).toBe(9_000);
    expect(rec.recommended?.assets?.inscriptionIds).toEqual(['abc123i0']);
    expect(resolveFundingPick(rec, 2_000)?.value).toBe(9_000);
    // The unnamed coin stays in the list for the expert picker.
    expect(rec.candidates.find((c) => c.value === 3_000)?.bucket).toBe('assets');
  });

  it('a bare-verdict coin is recommended over a tighter FAILED coin, still blocking', async () => {
    const failing = u('f', 3_000);
    const bare = u('n', 9_000);
    const { port } = fakeScan({ [op(failing)]: 'reject', [op(bare)]: 'has-assets' });
    const rec = await selectFunding(
      [failing, bare], 2_000, port, undefined, 'separate-payment-address',
    );
    expect(rec.status).toBe('expert-required');
    expect(rec.recommended?.value).toBe(9_000);
    expect(expertRequiredCause(rec)).toBe('unnamed-assets');
  });

  it('a clean coin carries no asset detail', async () => {
    const dirty = u('b', 9_000);
    const clean = u('c', 20_000);
    const rec = await selectFunding([clean, dirty], 2_000, detailPort(dirty), undefined, 'separate-payment-address');
    expect(rec.status).toBe('auto');
    expect(rec.recommended?.assets).toBeUndefined();
  });
});
