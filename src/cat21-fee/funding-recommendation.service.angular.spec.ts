import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, beforeEach } from '@jest/globals';
import { BehaviorSubject, Observable, firstValueFrom, of } from 'rxjs';

import { FundingRecommendationService } from './funding-recommendation.service';
import { UtxoContentScanner } from '../cat21-mint/utxo-content-scanner.service';
import { UtxoScanState } from '../cat21-mint/utxo-content.types';

/** A controllable stand-in for the ord-backed scanner. */
class FakeScanner {
  private map = new Map<string, UtxoScanState>();
  private subject = new BehaviorSubject<Map<string, UtxoScanState>>(new Map());
  readonly states$ = this.subject.asObservable();
  readonly scanned: string[] = [];

  set(op: string, s: UtxoScanState): void {
    this.map.set(op, s);
    this.subject.next(new Map(this.map));
  }
  getState(op: string): UtxoScanState {
    return this.map.get(op) ?? { kind: 'not-scanned' };
  }
  scan(op: string): Observable<UtxoScanState> {
    this.scanned.push(op);
    return of(this.getState(op));
  }
}

const u = (id: string, value: number) => ({ txid: id.repeat(64).slice(0, 64), vout: 0, value });
const op = (x: { txid: string; vout: number }) => `${x.txid}:${x.vout}`;
const assets = (): UtxoScanState => ({ kind: 'scanned-with-assets', content: {} as never });

describe('FundingRecommendationService', () => {
  let service: FundingRecommendationService;
  let scanner: FakeScanner;

  beforeEach(() => {
    scanner = new FakeScanner();
    const injector = Injector.create({
      providers: [{ provide: UtxoContentScanner, useValue: scanner }],
    });
    service = runInInjectionContext(injector, () => new FundingRecommendationService());
  });

  it('AUTO: a clean covering UTXO is auto-selected (best-fit clean)', async () => {
    const utxos = [u('a', 50_000), u('b', 3_000)];
    scanner.set(op(utxos[0]), { kind: 'scanned-clean' });
    scanner.set(op(utxos[1]), { kind: 'scanned-clean' });
    const rec = await firstValueFrom(service.recommend(of(utxos), of(2_000)));
    expect(rec.status).toBe('auto');
    expect(rec.recommended?.value).toBe(3_000); // smallest clean that covers
  });

  it('force-scans every COVERING candidate regardless of size (safety > threshold)', async () => {
    const utxos = [u('a', 5_000_000), u('b', 100)];
    scanner.set(op(utxos[0]), { kind: 'scanned-clean' });
    await firstValueFrom(service.recommend(of(utxos), of(2_000)));
    expect(scanner.scanned).toContain(op(utxos[0])); // the large covering coin WAS scanned
    expect(scanner.scanned).not.toContain(op(utxos[1])); // the non-covering coin was not
  });

  it('EXPERT-REQUIRED: only asset-bearing coins cover -> recommend best-fit, flag it', async () => {
    const utxos = [u('a', 50_000)];
    scanner.set(op(utxos[0]), assets());
    const rec = await firstValueFrom(service.recommend(of(utxos), of(2_000)));
    expect(rec.status).toBe('expert-required');
    expect(rec.recommended?.value).toBe(50_000);
    expect(rec.recommended?.bucket).toBe('assets');
  });

  it('never auto-spends the tighter ASSET coin when a clean coin also covers', async () => {
    const utxos = [u('a', 2_500), u('b', 40_000)]; // 2_500 is the tightest fit but carries assets
    scanner.set(op(utxos[0]), assets());
    scanner.set(op(utxos[1]), { kind: 'scanned-clean' });
    const rec = await firstValueFrom(service.recommend(of(utxos), of(2_000)));
    expect(rec.status).toBe('auto');
    expect(rec.recommended?.value).toBe(40_000);
    expect(rec.recommended?.bucket).toBe('clean');
  });

  it('INSUFFICIENT when nothing covers; no scans triggered', async () => {
    const utxos = [u('a', 500), u('b', 1_000)];
    const rec = await firstValueFrom(service.recommend(of(utxos), of(2_000)));
    expect(rec.status).toBe('insufficient');
    expect(scanner.scanned.length).toBe(0);
  });
});
