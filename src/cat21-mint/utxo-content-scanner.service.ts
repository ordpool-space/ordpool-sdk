import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable, catchError, firstValueFrom, forkJoin, from, map, mergeMap, of, shareReplay, tap } from 'rxjs';

import { ContentScanPort, UtxoClassification } from '../cat21-core/ports';
import { cat21Config } from './cat21-sdk-config';
import { fetchJson } from './http-fetch.helper';
import { classifyUtxoContent } from './utxo-content.classify';
import {
  Cat21OrdOutputResponse,
  OrdOutputResponse,
  UtxoContent,
  UtxoScanState,
} from './utxo-content.types';

/**
 * UTXOs at or below this value are auto-scanned by callers that respect
 * the default policy (the mint-flow components do). Above the threshold
 * a UTXO is overwhelmingly likely to be a plain payment, so we leave it
 * `not-scanned` and let the user click "Scan anyway" if they want
 * certainty. The 50k figure: most ordinal-bearing UTXOs are 546-10k
 * sat; rare-sat UTXOs are typically dust-postaged too. A 50k+ UTXO is
 * a deliberate-payment shape.
 */
export const AUTO_SCAN_MAX_VALUE_SAT = 50_000;

/**
 * Concurrency ceiling for `autoScan` HTTP fan-out. Each scan fires two
 * ord requests in parallel; six is the de-facto browser per-host
 * connection limit so we batch 5 outpoints (= 10 requests) at a time
 * to leave one slot for unrelated traffic.
 */
const AUTO_SCAN_CONCURRENCY = 5;

/**
 * Per-outpoint asset scanner backed by our ord instance
 * (`ord.ordpool.space`, for inscriptions + runes) and cat21-ord
 * (`ord.cat21.space`, for CAT-21 cats). Results are cached for the
 * singleton's lifetime — a UTXO's content is immutable until the UTXO
 * is spent, and a spent UTXO doesn't appear in the payment-address
 * list anymore, so the cache never goes stale.
 *
 * The scanner does NOT decide which UTXOs to scan; the caller picks
 * via `scan(outpoint)`. The orchestrator exposes the auto-scan
 * convenience separately.
 */
@Injectable({ providedIn: 'root' })
export class UtxoContentScanner implements ContentScanPort {
  private config = inject(cat21Config);

  /** outpoint → latest state. */
  private readonly states = new Map<string, UtxoScanState>();

  private readonly statesSubject = new BehaviorSubject<ReadonlyMap<string, UtxoScanState>>(new Map());

  /**
   * Live snapshot of every outpoint's scan state. Subscribers receive
   * the full map on every change so they can re-derive any per-row
   * bucket in one pass — no per-outpoint observable factory needed.
   */
  readonly states$ = this.statesSubject.asObservable();

  /** In-flight per-outpoint subscriptions so concurrent `scan()` calls dedupe. */
  private readonly inFlight = new Map<string, Observable<UtxoScanState>>();

  /**
   * Read the current state for one outpoint without subscribing.
   * Default: `not-scanned` for never-touched outpoints.
   */
  getState(outpoint: string): UtxoScanState {
    return this.states.get(outpoint) ?? { kind: 'not-scanned' };
  }

  /**
   * `ContentScanPort` adapter: resolve one outpoint to the orchestrators'
   * `'clean' | 'has-assets'` verdict, reusing this scanner's dedup + cache
   * (`scan()`), so the orchestrator's force-scan and the UI's per-row badges
   * hit the ord/cat21-ord endpoints once, not twice.
   *
   * FAIL-CLOSED: a `scan-failed` (content unknown) maps to `'has-assets'`, never
   * `'clean'` — an unverified coin must never be auto-spent. This is the whole
   * point of the force-scan funding-safety layer; hand-rolling the map per
   * consumer risks one wrong fail-open reopening the auto-spend footgun, which
   * is why it lives here (single source of truth).
   */
  async classify(outpoint: string): Promise<UtxoClassification> {
    const state = await firstValueFrom(this.scan(outpoint));
    return state.kind === 'scanned-clean' ? 'clean' : 'has-assets';
  }

  /**
   * Scan one outpoint. If already scanned, returns the cached state
   * synchronously via `of(...)`. If scan is in flight, returns the
   * existing observable so the network request runs once. Otherwise
   * fires both ord JSON queries in parallel, merges, caches, emits.
   *
   * The scan never throws — every failure mode is encoded into the
   * returned `UtxoScanState`.
   */
  scan(outpoint: string): Observable<UtxoScanState> {
    const cached = this.states.get(outpoint);
    if (cached && cached.kind !== 'not-scanned' && cached.kind !== 'scanning') {
      return of(cached);
    }
    const existing = this.inFlight.get(outpoint);
    if (existing) return existing;

    this.setState(outpoint, { kind: 'scanning' });

    const flight = forkJoin({
      ord: this.fetchOrd(outpoint),
      cat21Ord: this.fetchCat21Ord(outpoint),
    }).pipe(
      map(({ ord, cat21Ord }): UtxoScanState => {
        const c = classifyUtxoContent(ord, cat21Ord);
        if (c.clean) {
          return { kind: 'scanned-clean' };
        }
        const content: UtxoContent = {
          outpoint,
          inscriptionIds: c.inscriptionIds,
          runes: c.runes,
          catIds: c.catIds,
          catSat: c.catSat,
          rareSat: c.rareSat,
        };
        return { kind: 'scanned-with-assets', content };
      }),
      catchError((err: unknown): Observable<UtxoScanState> => {
        const message = err instanceof Error ? err.message : String(err);
        return of<UtxoScanState>({ kind: 'scan-failed', message });
      }),
      tap((state) => {
        this.setState(outpoint, state);
        this.inFlight.delete(outpoint);
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    this.inFlight.set(outpoint, flight);
    return flight;
  }

  /**
   * Convenience batch scanner. Scans every outpoint whose UTXO value
   * is at or below `AUTO_SCAN_MAX_VALUE_SAT`. Throttles HTTP fan-out
   * via `mergeMap` with `AUTO_SCAN_CONCURRENCY` so a wallet with 30
   * UTXOs doesn't try to open 60 simultaneous TCP connections (browser
   * per-host cap is 6, anything above queues anyway). Returns nothing
   * — the caller reads results off the `states$` stream.
   */
  autoScan(utxos: { txid: string; vout: number; value: number }[]): void {
    const targets: string[] = [];
    for (const u of utxos) {
      if (u.value > AUTO_SCAN_MAX_VALUE_SAT) continue;
      const outpoint = `${u.txid}:${u.vout}`;
      if (this.getState(outpoint).kind === 'not-scanned') {
        targets.push(outpoint);
      }
    }
    if (targets.length === 0) return;
    from(targets).pipe(
      mergeMap((outpoint) => this.scan(outpoint), AUTO_SCAN_CONCURRENCY),
    ).subscribe();
  }

  /**
   * Wipe both caches. Call this when the connected wallet changes —
   * UTXO outpoints from the previous wallet are no longer relevant
   * and would otherwise accumulate forever on a long-lived session
   * (the singleton's `states` Map is unbounded).
   */
  reset(): void {
    this.states.clear();
    this.inFlight.clear();
    this.statesSubject.next(new Map());
  }

  private fetchOrd(outpoint: string): Observable<OrdOutputResponse> {
    return fetchJson<OrdOutputResponse>(`${trimSlash(this.config.ordApiUrl)}/output/${outpoint}`);
  }

  private fetchCat21Ord(outpoint: string): Observable<Cat21OrdOutputResponse> {
    return fetchJson<Cat21OrdOutputResponse>(`${trimSlash(this.config.cat21OrdApiUrl)}/output/${outpoint}`);
  }

  private setState(outpoint: string, state: UtxoScanState): void {
    this.states.set(outpoint, state);
    this.statesSubject.next(new Map(this.states));
  }
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
