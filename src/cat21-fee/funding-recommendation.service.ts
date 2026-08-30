import { Injectable, inject } from '@angular/core';
import { Observable, combineLatest, map, of, switchMap } from 'rxjs';

import { UtxoContentScanner } from '../cat21-mint/utxo-content-scanner.service';
import { bucketOf } from '../cat21-mint/utxo-content.types';
import { FundingUtxo } from './coin-selection.helper';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  recommendFunding,
} from './funding-safety';

const outpointKey = (u: FundingUtxo): string => `${u.txid}:${u.vout}`;

/**
 * The shared coin-selection brain for EVERY cat action's orchestrator.
 *
 * Given the wallet's funding UTXOs and the spend target, it force-scans the
 * COVERING candidates for content (any size — so the "never auto-spend a
 * valuable coin" guarantee holds even for the large funding UTXOs that
 * `UtxoContentScanner.autoScan`'s size threshold skips), then applies the pure
 * `recommendFunding`. It re-emits as scans resolve: `scanning` while content is
 * unknown, then `auto` (a clean coin covers → auto-select, no picker),
 * `expert-required` (only asset/scan-failed coins cover → recommend best-fit but
 * the UI must confirm), or `insufficient`.
 *
 * Wiring this into mint / transfer / offer / inscribe gives all four actions
 * identical safe-auto + expert-with-recommendation behaviour, in the SDK, so no
 * consumer (cat21.space, cat21-wallet, bots) re-implements it. The "by value"
 * pick inside `recommendFunding` is ord's best-fit `selectCardinalUtxo`, so an
 * auto-selected clean coin stays byte-aligned with `ord wallet send`.
 */
@Injectable({ providedIn: 'root' })
export class FundingRecommendationService {
  private scanner = inject(UtxoContentScanner);

  /**
   * `preferredSpendSats$` (optional, defaults to no bias) is the WITH-CHANGE +
   * dust headroom target, above the no-change feasibility `targetSpendSats$`.
   * When supplied, the auto-pick is biased toward a clean coin that clears it,
   * so the spend emits an above-dust change and the realised fee-rate lands on
   * the requested rate instead of a sub-dust leftover being absorbed into the
   * fee. `targetSpendSats$` stays the coverage gate (never a false
   * `insufficient`). Mirrors `selectFunding`'s `preferredSats`.
   */
  recommend<T extends FundingUtxo>(
    fundingUtxos$: Observable<ReadonlyArray<T>>,
    targetSpendSats$: Observable<number | null>,
    preferredSpendSats$: Observable<number | null> = of(null),
  ): Observable<FundingRecommendation<T & AnnotatedFundingUtxo>> {
    return combineLatest([fundingUtxos$, targetSpendSats$, preferredSpendSats$]).pipe(
      switchMap(([utxos, target, preferred]) => {
        if (!target || target <= 0 || utxos.length === 0) {
          return of(recommendFunding<T & AnnotatedFundingUtxo>([], target ?? 0));
        }

        // Force-scan every covering candidate — safety takes priority over the
        // scanner's size threshold: any coin we might auto-spend gets checked.
        // scan() dedupes + caches + completes after one emit, so these
        // fire-and-forget subscriptions clean themselves up.
        for (const u of utxos) {
          if (u.value >= target) this.scanner.scan(outpointKey(u)).subscribe();
        }

        // Re-derive the recommendation on every scan-state change (states$ is a
        // BehaviorSubject, so this also emits the current snapshot immediately).
        return this.scanner.states$.pipe(
          map(() => {
            const annotated = utxos.map(
              (u): T & AnnotatedFundingUtxo => ({
                ...u,
                bucket: bucketOf(this.scanner.getState(outpointKey(u))),
              }),
            );
            return recommendFunding(annotated, target, preferred ?? undefined);
          }),
        );
      }),
    );
  }
}
