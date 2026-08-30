import { describe, expect, it } from '@jest/globals';

import { AnnotatedFundingUtxo, recommendFunding } from './funding-safety';
import { UtxoScanBucket } from '../cat21-mint/utxo-content.types';

let n = 0;
const u = (value: number, bucket: UtxoScanBucket): AnnotatedFundingUtxo => ({
  txid: (n++).toString(16).padStart(64, '0'),
  vout: 0,
  value,
  bucket,
});

describe('recommendFunding — safe-auto with expert fallback', () => {
  it('AUTO: picks the best-fit (smallest covering) CLEAN UTXO', () => {
    const r = recommendFunding(
      [u(50_000, 'clean'), u(3_000, 'clean'), u(10_000, 'clean')],
      2_000,
    );
    expect(r.status).toBe('auto');
    expect(r.recommended?.value).toBe(3_000); // smallest that covers (ord best-fit)
  });

  it('AUTO: ignores asset-bearing UTXOs even when they are a better value fit', () => {
    // A 2_500-sat ASSET coin is the tightest fit, but it carries content — the
    // clean 10_000 is chosen instead, and we never auto-burn the asset.
    const r = recommendFunding(
      [u(2_500, 'assets'), u(10_000, 'clean'), u(80_000, 'clean')],
      2_000,
    );
    expect(r.status).toBe('auto');
    expect(r.recommended?.value).toBe(10_000);
    expect(r.recommended?.bucket).toBe('clean');
  });

  it('EXPERT-REQUIRED: only asset-bearing UTXOs cover -> recommend best-fit but flag it', () => {
    const r = recommendFunding(
      [u(200, 'clean'), u(9_000, 'assets'), u(50_000, 'assets')],
      2_000,
    );
    expect(r.status).toBe('expert-required');
    expect(r.recommended?.value).toBe(9_000); // best-fit covering (valuable) — the UI must confirm
    expect(r.recommended?.bucket).toBe('assets');
  });

  it('EXPERT-REQUIRED: a failed scan (unknown content) is never auto-spent', () => {
    const r = recommendFunding([u(10_000, 'failed')], 2_000);
    expect(r.status).toBe('expert-required');
    expect(r.recommended?.value).toBe(10_000);
  });

  it('SCANNING: a covering candidate is still unscanned -> wait, no recommendation yet', () => {
    const r = recommendFunding(
      [u(200, 'clean'), u(50_000, 'unscanned')],
      2_000,
    );
    expect(r.status).toBe('scanning');
    expect(r.recommended).toBeNull();
  });

  it('INSUFFICIENT: nothing covers the spend', () => {
    const r = recommendFunding([u(500, 'clean'), u(1_000, 'assets')], 2_000);
    expect(r.status).toBe('insufficient');
    expect(r.recommended).toBeNull();
  });

  it('always returns the full annotated candidate list for the expert picker', () => {
    const cands = [u(50_000, 'clean'), u(2_500, 'assets')];
    const r = recommendFunding(cands, 2_000);
    expect(r.candidates).toBe(cands);
  });

  it('a clean cover wins even while OTHER (non-covering) candidates are still scanning', () => {
    const r = recommendFunding(
      [u(50_000, 'clean'), u(100, 'scanning')],
      2_000,
    );
    expect(r.status).toBe('auto'); // the clean 50k covers; the scanning 100 is irrelevant
    expect(r.recommended?.value).toBe(50_000);
  });
});

describe('recommendFunding — change-headroom preference (dust-cliff over-pay guard)', () => {
  // feasibility = no-change fee (a coin >= this can spend at all); preferred =
  // with-change fee + dust (a coin >= this leaves an above-dust change, so the
  // realised fee-rate lands on target instead of the sub-dust leftover being
  // absorbed into the fee). Both tight coins here clear feasibility (12_746) but
  // only the 20_000 clears preferred (14_192): the auto-pick MUST take it.
  const FEASIBILITY = 12_746;
  const PREFERRED = 14_192;

  it('prefers a clean coin with change-headroom over a tighter clean coin that only clears feasibility', () => {
    const r = recommendFunding(
      [u(13_100, 'clean'), u(20_000, 'clean')],
      FEASIBILITY,
      PREFERRED,
    );
    expect(r.status).toBe('auto');
    // Best-fit tight pick would be 13_100 (smallest covering feasibility); the
    // headroom bias must skip it for the 20_000 that clears PREFERRED.
    expect(r.recommended?.value).toBe(20_000);
  });

  it('best-fit AMONG headroom coins (smallest that clears preferred), not the globally largest', () => {
    const r = recommendFunding(
      [u(13_100, 'clean'), u(15_000, 'clean'), u(90_000, 'clean')],
      FEASIBILITY,
      PREFERRED,
    );
    expect(r.recommended?.value).toBe(15_000); // smallest clean coin over PREFERRED
  });

  it('FALLBACK: only tight coins (none clear preferred) → still auto-picks best-fit, never insufficient', () => {
    const r = recommendFunding(
      [u(13_100, 'clean'), u(13_500, 'clean')],
      FEASIBILITY,
      PREFERRED,
    );
    expect(r.status).toBe('auto'); // the spend still succeeds (bounded over-pay)
    expect(r.recommended?.value).toBe(13_100); // best-fit over feasibility
  });

  it('no preferred target → unchanged best-fit-over-feasibility behaviour', () => {
    const r = recommendFunding([u(13_100, 'clean'), u(20_000, 'clean')], FEASIBILITY);
    expect(r.recommended?.value).toBe(13_100); // smallest covering, as before
  });

  it('feasibility is still the coverage gate: nothing clears it → insufficient (preferred is only a bias)', () => {
    const r = recommendFunding([u(10_000, 'clean')], FEASIBILITY, PREFERRED);
    expect(r.status).toBe('insufficient');
  });
});
