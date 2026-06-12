import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable, catchError, forkJoin, map, of, shareReplay, tap } from 'rxjs';

import { cat21Config } from './cat21-sdk-config';
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
 * Per-outpoint asset scanner backed by ord-proxy (`ord.ordpool.space`,
 * for inscriptions + runes) and cat21-ord (`ord.cat21.space`, for CAT-
 * 21 cats). Results are cached for the singleton's lifetime — a UTXO's
 * content is immutable until the UTXO is spent, and a spent UTXO
 * doesn't appear in the payment-address list anymore, so the cache
 * never goes stale.
 *
 * The scanner does NOT decide which UTXOs to scan; the caller picks
 * via `scan(outpoint)`. The orchestrator exposes the auto-scan
 * convenience separately.
 */
@Injectable({ providedIn: 'root' })
export class UtxoContentScanner {
  private http = inject(HttpClient);
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
        const inscriptionIds = ord.inscriptions ?? [];
        const runes = ord.runes && Object.keys(ord.runes).length > 0 ? ord.runes : null;
        const catIds = cat21Ord.cats ?? [];

        if (inscriptionIds.length === 0 && !runes && catIds.length === 0) {
          return { kind: 'scanned-clean' };
        }
        const content: UtxoContent = { outpoint, inscriptionIds, runes, catIds };
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
      shareReplay({ bufferSize: 1, refCount: false }),
    );

    this.inFlight.set(outpoint, flight);
    return flight;
  }

  /**
   * Convenience batch scanner. Scans every outpoint whose UTXO value
   * is at or below `AUTO_SCAN_MAX_VALUE_SAT`. Returns nothing — the
   * caller reads results off the `states$` stream.
   */
  autoScan(utxos: { txid: string; vout: number; value: number }[]): void {
    for (const u of utxos) {
      if (u.value > AUTO_SCAN_MAX_VALUE_SAT) continue;
      const outpoint = `${u.txid}:${u.vout}`;
      const s = this.getState(outpoint);
      if (s.kind === 'not-scanned') {
        this.scan(outpoint).subscribe();
      }
    }
  }

  private fetchOrd(outpoint: string): Observable<OrdOutputResponse> {
    const url = `${trimSlash(this.config.ordApiUrl)}/output/${outpoint}`;
    return this.http.get<OrdOutputResponse>(url, {
      headers: { Accept: 'application/json' },
    });
  }

  private fetchCat21Ord(outpoint: string): Observable<Cat21OrdOutputResponse> {
    const url = `${trimSlash(this.config.cat21OrdApiUrl)}/output/${outpoint}`;
    return this.http.get<Cat21OrdOutputResponse>(url, {
      headers: { Accept: 'application/json' },
    });
  }

  private setState(outpoint: string, state: UtxoScanState): void {
    this.states.set(outpoint, state);
    this.statesSubject.next(new Map(this.states));
  }
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
