import { describe, expect, it, jest } from '@jest/globals';
import { HttpClient } from '@angular/common/http';
import { Injector, runInInjectionContext } from '@angular/core';
import { firstValueFrom, Observable, of } from 'rxjs';

import { cat21Config } from './cat21-sdk-config';
import { UtxoContentScanner } from './utxo-content-scanner.service';

const ordApiUrl = 'https://ord.test';
const cat21OrdApiUrl = 'https://cat21ord.test';

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
type MockHttp = {
  get: jest.MockedFunction<(url: string, opts?: unknown) => Observable<HttpGetResult>>;
};

function buildScanner(ordBody: HttpGetResult, cat21OrdBody: HttpGetResult) {
  const http: MockHttp = { get: jest.fn<MockHttp['get']>() };
  http.get.mockImplementation((url: string) =>
    of(url.startsWith(cat21OrdApiUrl) ? cat21OrdBody : ordBody)
  );

  const injector = Injector.create({
    providers: [
      { provide: HttpClient, useValue: http },
      { provide: cat21Config, useValue: { ordApiUrl, cat21OrdApiUrl } },
    ],
  });

  const scanner = runInInjectionContext(injector, () => new UtxoContentScanner());
  return { scanner, http };
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

  it('leaves catSat null when ord supplied no sat ranges', async () => {
    const { scanner } = buildScanner(
      // An output ord has not sat-indexed. The cat is still flagged; only the
      // link target is unavailable.
      { value: 546, inscriptions: [], runes: null },
      { value: 546, cats: [CAT_ID] }
    );

    const state = await firstValueFrom(scanner.scan(OUTPOINT));

    if (state.kind !== 'scanned-with-assets') throw new Error('expected assets');
    expect(state.content.catIds).toEqual([CAT_ID]);
    expect(state.content.catSat).toBeNull();
  });
});
