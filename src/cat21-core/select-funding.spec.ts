import { describe, expect, it } from '@jest/globals';

import { ContentScanPort, UtxoClassification } from './ports';
import { selectFunding } from './select-funding';

// A plain NODE unit test — no jsdom. That the framework-agnostic
// core selection is testable this way is the whole point of the migration.

const u = (id: string, value: number, vout = 0) => ({
  txid: id.repeat(64).slice(0, 64),
  vout,
  value,
});
const op = (x: { txid: string; vout: number }) => `${x.txid}:${x.vout}`;

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
