import { describe, expect, it } from '@jest/globals';

import { AnnotatedFundingUtxo, isOneAddressWallet, recommendFunding } from './funding-safety.js';
import { UtxoScanBucket } from '../cat21-mint/utxo-content.types.js';

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

describe('the documented mutation point', () => {

  it('the clean filter is still one line matching the recipe three repos mutate', () => {
    // All FOUR consumers (ordpool, cat21-indexer, cubes, cat21-wallet)
    // prove their own wiring by neutralising the SAME line in this file:
    //
    //     covering.filter((c) => c.bucket === 'clean')  ->  covering.filter(() => true)
    //
    // A refactor that splits or renames it does not break anything here, so
    // their recipes would quietly stop neutralising the guard and their
    // mutations would pass while proving nothing. That matters most for
    // cat21-wallet, whose autonomous mode signs with no human watching, so
    // this guard is its last line rather than one of two. This pins the shape so that
    // change fails HERE, where whoever makes it is looking.
    //
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'funding-safety.ts'), 'utf8');

    const matches = src.match(/covering\.filter\(\(c\) => c\.bucket === 'clean'\)/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe('recommendFunding — how hard to stand in the way depends on the wallet', () => {
  // The risk to the coin is identical in both cases; only the obstruction
  // differs, because a one-address wallet keeps assets and spending money in
  // the same lane where an accidental spend is likelier and less visible.
  const onlyDirtyCovers = () => [u(200, 'clean'), u(9_000, 'assets'), u(50_000, 'assets')];

  it('NOTICE, not a block, on a wallet with a separate payment address', () => {
    const r = recommendFunding(onlyDirtyCovers(), 2_000, undefined, 'separate-payment-address');
    expect(r.status).toBe('asset-notice');
    expect(r.recommended?.value).toBe(9_000);
    expect(r.recommended?.bucket).toBe('assets');
  });

  it('BLOCKS on a wallet that uses one address for everything', () => {
    const r = recommendFunding(onlyDirtyCovers(), 2_000, undefined, 'one-address-for-everything');
    expect(r.status).toBe('expert-required');
    expect(r.recommended?.value).toBe(9_000);
  });

  it('recommends the SAME coin either way, so only the obstruction differs', () => {
    const separate = recommendFunding(onlyDirtyCovers(), 2_000, undefined, 'separate-payment-address');
    const shared = recommendFunding(onlyDirtyCovers(), 2_000, undefined, 'one-address-for-everything');
    expect(separate.recommended?.value).toBe(shared.recommended?.value);
    expect(separate.candidates.length).toBe(shared.candidates.length);
  });

  it('defaults to the BLOCKING branch, so an un-migrated caller over-blocks', () => {
    // Fail closed: a consumer that has not yet threaded its wallet's topology
    // keeps the stricter behaviour rather than silently letting an asset
    // through on a single-address wallet.
    expect(recommendFunding(onlyDirtyCovers(), 2_000).status).toBe('expert-required');
  });

  it('topology never overrides a clean coin: a separate-address wallet still goes silent', () => {
    const r = recommendFunding(
      [u(2_500, 'assets'), u(10_000, 'clean')],
      2_000,
      undefined,
      'separate-payment-address',
    );
    expect(r.status).toBe('auto');
    expect(r.recommended?.bucket).toBe('clean');
  });

  it('topology never overrides an unfinished scan', () => {
    const r = recommendFunding(
      [u(9_000, 'assets'), u(20_000, 'scanning')],
      2_000,
      undefined,
      'separate-payment-address',
    );
    expect(r.status).toBe('scanning');
    expect(r.recommended).toBeNull();
  });
});

describe('isOneAddressWallet derives topology instead of listing wallet names', () => {
  it('is true when both lanes hold the same address (unisat / wizz / okx / binance / alby shape)', () => {
    expect(isOneAddressWallet({
      paymentAddress: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx',
      ordinalsAddress: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx',
    })).toBe(true);
  });

  it('is false when the lanes differ (xverse / leather / phantom / cat21wallet shape)', () => {
    expect(isOneAddressWallet({
      paymentAddress: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx',
      ordinalsAddress: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9',
    })).toBe(false);
  });
});
