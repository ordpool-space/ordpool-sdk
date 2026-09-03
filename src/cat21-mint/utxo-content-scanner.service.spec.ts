import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { firstValueFrom, of } from 'rxjs';

import { Cat21SdkConfig } from './cat21-sdk-config';
import { UtxoContentScanner } from './utxo-content-scanner.service';
import { UtxoScanState } from './utxo-content.types';

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
    expect(await scanner.classify('aa:0')).toBe('clean');
  });

  it('scanned-with-assets => has-assets', async () => {
    const scanner = makeScanner();
    jest.spyOn(scanner, 'scan').mockReturnValue(
      of<UtxoScanState>({ kind: 'scanned-with-assets', content: {} as never }),
    );
    expect(await scanner.classify('aa:0')).toBe('has-assets');
  });

  it('scan-failed => has-assets (FAIL-CLOSED — an unverified coin is never auto-spent)', async () => {
    const scanner = makeScanner();
    jest.spyOn(scanner, 'scan').mockReturnValue(of<UtxoScanState>({ kind: 'scan-failed', message: 'ord down' }));
    expect(await scanner.classify('aa:0')).toBe('has-assets');
  });
});
