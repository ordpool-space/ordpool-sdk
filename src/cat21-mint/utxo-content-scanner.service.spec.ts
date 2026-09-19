import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { firstValueFrom, of } from 'rxjs';

import { Cat21SdkConfig } from './cat21-sdk-config.js';
import { AUTO_SCAN_MAX_VALUE_SAT, UtxoContentScanner } from './utxo-content-scanner.service.js';
import { UtxoScanState } from './utxo-content.types.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ordApiUrl = 'https://ord.test';
const cat21OrdApiUrl = 'https://cat21ord.test';
const cfg: Cat21SdkConfig = { mempoolApiUrl: '', cat21ApiUrl: '', ordApiUrl, cat21OrdApiUrl };

/**
 * Genesis cat, with the two `GET /output/<outpoint>` bodies its hosts really
 * return. Kept verbatim because the hosts disagree on the cat key —
 * ord.ordpool.space says `inscriptions`, cat21-ord says `cats`, since it
 * rewrites its own JSON — and a hand-written pair would hide that.
 */
const OUTPOINT = '98316dcb21daaa221865208fe0323616ee6dd84e6020b78bc6908e914ac03892:0';
const CAT_ID = '98316dcb21daaa221865208fe0323616ee6dd84e6020b78bc6908e914ac03892i0';

/** ord reports this same number as the cat's `sat` on GET /cat/0. */
const GENESIS_SAT = 596964966600565;

type HttpGetResult = Record<string, unknown>;

function buildScanner(ordBody: HttpGetResult, cat21OrdBody: HttpGetResult) {
  // Mock native fetch (the scanner's HTTP primitive) — return each host's
  // `GET /output/<outpoint>` body based on the URL, mirroring what the two ord
  // instances really answer.
  const fetchMock = jest.fn((input: string | URL | Request) => {
    const url = String(input);
    const body = url.startsWith(cat21OrdApiUrl) ? cat21OrdBody : ordBody;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as unknown as Response);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const scanner = new UtxoContentScanner(cfg);
  return { scanner, fetchMock };
}

describe('UtxoContentScanner catSat', () => {
  it('reports the sat the cat sits on', async () => {
    const { scanner } = buildScanner(
      { value: 546, inscriptions: [], runes: null, sat_ranges: [[GENESIS_SAT, 596964966601111]] },
      { value: 546, cats: [CAT_ID] }
    );

    const state = await firstValueFrom(scanner.scan(OUTPOINT));

    expect(state.kind).toBe('scanned-with-assets');
    if (state.kind !== 'scanned-with-assets') return;
    expect(state.content.catIds).toEqual([CAT_ID]);
    // CAT-21 pins a cat to offset 0, so the opening sat of the first range is
    // the cat's sat — the same number ord answers for GET /cat/0.
    expect(state.content.catSat).toBe(GENESIS_SAT);
  });

  it('leaves catSat null when the outpoint holds no cat', async () => {
    const { scanner } = buildScanner(
      // A plain inscription still makes this "with assets", so the branch is
      // reached with an empty cat list rather than short-circuiting to clean.
      { value: 546, inscriptions: ['abc123i0'], runes: null, sat_ranges: [[GENESIS_SAT, 1]] },
      { value: 546, cats: [] }
    );

    const state = await firstValueFrom(scanner.scan(OUTPOINT));

    if (state.kind !== 'scanned-with-assets') throw new Error('expected assets');
    expect(state.content.catIds).toEqual([]);
    expect(state.content.catSat).toBeNull();
  });

  it('leaves catSat null only when NEITHER instance has sat ranges', async () => {
    const { scanner } = buildScanner(
      // Neither the full ord nor cat21-ord returned sat ranges for this
      // output. The cat is still flagged; only the sat link is unavailable.
      { value: 546, inscriptions: [], runes: null },
      { value: 546, cats: [CAT_ID] }
    );

    const state = await firstValueFrom(scanner.scan(OUTPOINT));

    if (state.kind !== 'scanned-with-assets') throw new Error('expected assets');
    expect(state.content.catIds).toEqual([CAT_ID]);
    expect(state.content.catSat).toBeNull();
  });

  it('routes an output NEITHER ord has indexed to scan-failed, not to clean', async () => {
    // Both instances answer 200 with no sat ranges, which is what ord returns
    // for an output whose block it has not finished indexing. That body is
    // byte-identical to a genuinely empty output, so reading it as clean is how
    // a freshly-confirmed asset-bearing coin gets spent for fees.
    const { scanner } = buildScanner(
      { value: 546, inscriptions: [], runes: null },
      { value: 546, cats: [] },
    );

    const state = await firstValueFrom(scanner.scan(OUTPOINT));

    expect(state.kind).toBe('scan-failed');
    if (state.kind !== 'scan-failed') throw new Error('expected scan-failed');
    // The message says "unknown", not "has assets": the caller and any human
    // reading a log need to know this is no-answer rather than a detection.
    expect(state.message).toContain('has not indexed');
  });

  it('sources catSat from cat21-ord (authoritative) when the full ord has not indexed the output', async () => {
    const { scanner } = buildScanner(
      // Full ord lagging: no sat ranges for this output yet.
      { value: 546, inscriptions: [], runes: null },
      // cat21-ord (--index-sats) is the cat indexer and has the sat.
      { value: 546, cats: [CAT_ID], sat_ranges: [[GENESIS_SAT, 596964966601111]] }
    );

    const state = await firstValueFrom(scanner.scan(OUTPOINT));

    if (state.kind !== 'scanned-with-assets') throw new Error('expected assets');
    expect(state.content.catIds).toEqual([CAT_ID]);
    // Before the fix this was null (catSat read only from the full ord).
    expect(state.content.catSat).toBe(GENESIS_SAT);
  });
});

describe('UtxoContentScanner.classify (ContentScanPort adapter)', () => {
  function makeScanner(): UtxoContentScanner {
    return new UtxoContentScanner(cfg);
  }
  it('scanned-clean => clean', async () => {
    const scanner = makeScanner();
    jest.spyOn(scanner, 'scan').mockReturnValue(of<UtxoScanState>({ kind: 'scanned-clean' }));
    expect(await scanner.classify('aa:0')).toEqual({ verdict: 'clean' });
  });

  it('scanned-with-assets => has-assets, carrying WHAT was found', async () => {
    const scanner = makeScanner();
    jest.spyOn(scanner, 'scan').mockReturnValue(
      of<UtxoScanState>({
        kind: 'scanned-with-assets',
        content: {
          outpoint: 'aa:0',
          inscriptionIds: ['abc123i0'],
          runes: { 'UNCOMMON•GOODS': { amount: '1', divisibility: 0, symbol: '⧉' } },
          catIds: ['def456i0'],
          catSat: 1857900000000000,
          rareSat: { sat: '1857900000000000', block: 371, rarity: 'uncommon' },
        },
      }),
    );
    // The names, not just the flag: nobody can consent to losing an asset they
    // cannot see, and this adapter is the single place that already knows.
    expect(await scanner.classify('aa:0')).toEqual({
      verdict: 'has-assets',
      assets: {
        inscriptionIds: ['abc123i0'],
        // Rune BALANCES stay behind; a row renders the name.
        runeNames: ['UNCOMMON•GOODS'],
        catIds: ['def456i0'],
        rareSat: { sat: '1857900000000000', block: 371, rarity: 'uncommon' },
      },
    });
  });

  it('scan-failed => has-assets (FAIL-CLOSED — an unverified coin is never auto-spent)', async () => {
    const scanner = makeScanner();
    jest.spyOn(scanner, 'scan').mockReturnValue(of<UtxoScanState>({ kind: 'scan-failed', message: 'ord down' }));
    // Unknown content fails closed AND offers no detail, because there is none
    // to offer. A caller must not read absent detail as "nothing on the coin".
    expect(await scanner.classify('aa:0')).toEqual({ verdict: 'has-assets' });
  });
});

describe('UtxoContentScanner cache: a failed scan is not a verdict', () => {
  /** Count real HTTP attempts; the cache is what decides whether one happens. */
  function countingFetch(fail: boolean): { calls: () => number } {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (fail) throw new Error('ord unreachable');
      return { ok: true, status: 200, json: async () => ({ sat_ranges: [[100, 200]], inscriptions: [], runes: {} }) };
    }) as unknown as typeof globalThis.fetch;
    return { calls: () => calls };
  }

  it('RE-ATTEMPTS an outpoint whose previous scan failed', async () => {
    const { calls } = countingFetch(true);
    const scanner = new UtxoContentScanner(cfg);
    await firstValueFrom(scanner.scan('bb:0'));
    const afterFirst = calls();
    expect(scanner.getState('bb:0').kind).toBe('scan-failed');

    // A failure describes the last ATTEMPT, not the outpoint: ord being briefly
    // unreachable, or not yet having indexed the output, both resolve on their
    // own. Serving that from cache would freeze the coin for the scanner's
    // whole lifetime.
    await firstValueFrom(scanner.scan('bb:0'));
    expect(calls()).toBeGreaterThan(afterFirst);
  });

  it('does NOT re-attempt an outpoint that scanned cleanly', async () => {
    // Contents cannot change once ord has processed the block that created the
    // output, so re-fetching is pure cost.
    const { calls } = countingFetch(false);
    const scanner = new UtxoContentScanner(cfg);
    await firstValueFrom(scanner.scan('cc:0'));
    const afterFirst = calls();
    await firstValueFrom(scanner.scan('cc:0'));
    expect(calls()).toBe(afterFirst);
  });
});

describe('UtxoContentScanner autoScan gates', () => {
  const clean = { value: 1_000, inscriptions: [], runes: null, sat_ranges: [[1, 2]] };
  const coin = (value: number, id: string) => ({ txid: id.repeat(64).slice(0, 64), vout: 0, value });

  /** Outpoints the scanner actually fetched, deduped across the two hosts. */
  const scanned = (fetchMock: { mock: { calls: unknown[][] } }): string[] => [
    ...new Set(
      fetchMock.mock.calls
        .map((c) => String(c[0]).split('/output/')[1])
        .filter((x): x is string => !!x),
    ),
  ];

  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('skips coins ABOVE the ceiling: a big coin is scanned on demand, not in the background', async () => {
    const { scanner, fetchMock } = buildScanner(clean, { value: 1_000, cats: [] });
    scanner.autoScan([coin(1_000, 'a'), coin(AUTO_SCAN_MAX_VALUE_SAT + 1, 'b')]);
    await settle();
    expect(scanned(fetchMock)).toEqual([`${'a'.repeat(64)}:0`]);
  });

  it('skips coins BELOW the funding floor: dust can never be selected, so scanning it buys nothing', async () => {
    const { scanner, fetchMock } = buildScanner(clean, { value: 1_000, cats: [] });
    // 546 cannot cover postage + a positive fee at any rate, so it is below the
    // floor for every plan; 5_000 covers.
    scanner.autoScan([coin(546, 'c'), coin(5_000, 'd')], 1_000);
    await settle();
    expect(scanned(fetchMock)).toEqual([`${'d'.repeat(64)}:0`]);
  });

  it('scans everything under the ceiling when no floor is known yet', async () => {
    const { scanner, fetchMock } = buildScanner(clean, { value: 1_000, cats: [] });
    scanner.autoScan([coin(546, 'e'), coin(5_000, 'f')]);
    await settle();
    expect(scanned(fetchMock).sort()).toEqual(
      [`${'e'.repeat(64)}:0`, `${'f'.repeat(64)}:0`].sort(),
    );
  });
});
