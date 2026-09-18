import { describe, expect, it } from '@jest/globals';

import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  liftRecommendationByOutpoint,
} from './funding-safety.js';

/**
 * Every frontend reaches its funding recommendation through this lift: the core
 * returns coins in its own shape, and the orchestrator re-keys them onto the
 * richer objects the UI holds. So anything the lift drops is invisible to all
 * three consumers at once, no matter how well the layer below carries it.
 */
const ASSETS = {
  inscriptionIds: ['abc123i0'],
  runeNames: ['UNCOMMON•GOODS'],
  catIds: ['def456i0'],
  rareSat: { sat: '1857900000000000', block: 371, rarity: 'uncommon' },
};

const core = (txid: string, value: number, extra: Partial<AnnotatedFundingUtxo> = {}): AnnotatedFundingUtxo => ({
  txid, vout: 0, value, bucket: 'assets', ...extra,
});

/** What a consumer holds: the same outpoint plus its own fields. */
const rich = (txid: string, value: number) => ({
  txid, vout: 0, value, status: { confirmed: true }, scriptPubKey: 'deadbeef',
});

describe('liftRecommendationByOutpoint', () => {
  it('carries the asset NAMES onto the lifted recommendation', () => {
    const rec: FundingRecommendation<AnnotatedFundingUtxo> = {
      status: 'asset-notice',
      recommended: core('aa', 9_000, { assets: ASSETS }),
      candidates: [core('aa', 9_000, { assets: ASSETS })],
    };
    const lifted = liftRecommendationByOutpoint(rec, [rich('aa', 9_000)]);
    // The whole point: a notice rendered from the lifted object must still be
    // able to say WHICH inscription and WHICH cat.
    expect(lifted.recommended?.assets).toEqual(ASSETS);
    expect(lifted.candidates[0]?.assets).toEqual(ASSETS);
  });

  it('carries them on a BLOCKED recommendation, which is what a picker renders', () => {
    const rec: FundingRecommendation<AnnotatedFundingUtxo> = {
      status: 'expert-required',
      recommended: core('aa', 9_000, { assets: ASSETS }),
      candidates: [core('aa', 9_000, { assets: ASSETS })],
    };
    const lifted = liftRecommendationByOutpoint(rec, [rich('aa', 9_000)]);
    expect(lifted.status).toBe('expert-required');
    expect(lifted.recommended?.assets?.inscriptionIds).toEqual(['abc123i0']);
  });

  it('keeps the bucket and merges the consumer fields', () => {
    const rec: FundingRecommendation<AnnotatedFundingUtxo> = {
      status: 'auto',
      recommended: core('aa', 9_000, { bucket: 'clean' }),
      candidates: [core('aa', 9_000, { bucket: 'clean' })],
    };
    const lifted = liftRecommendationByOutpoint(rec, [rich('aa', 9_000)]);
    expect(lifted.recommended?.bucket).toBe('clean');
    expect((lifted.recommended as unknown as { scriptPubKey: string }).scriptPubKey).toBe('deadbeef');
    // A clean coin carries no detail, and absent detail must stay absent rather
    // than becoming an empty object a template could read as "nothing on it".
    expect(lifted.recommended?.assets).toBeUndefined();
  });

  it('lets the SOURCE object win a conflicting field, per its contract', () => {
    // The doc says the scan annotation is preserved and the source supplies its
    // fields. That makes the spread ORDER load-bearing, and nothing pins it
    // while every fixture agrees on every shared key: reverse the spread and a
    // suite of matching values stays green while the contract has inverted.
    const rec: FundingRecommendation<AnnotatedFundingUtxo> = {
      status: 'auto',
      recommended: core('aa', 9_000, { bucket: 'clean' }),
      candidates: [core('aa', 9_000, { bucket: 'clean' })],
    };
    const lifted = liftRecommendationByOutpoint(rec, [rich('aa', 7_777)]);
    expect(lifted.recommended?.value).toBe(7_777);
    // ...while the annotation, which the source does not carry, survives.
    expect(lifted.recommended?.bucket).toBe('clean');
  });

  it('drops a candidate the consumer no longer holds, rather than inventing one', () => {
    const rec: FundingRecommendation<AnnotatedFundingUtxo> = {
      status: 'auto',
      recommended: core('aa', 9_000, { bucket: 'clean' }),
      candidates: [core('aa', 9_000, { bucket: 'clean' }), core('bb', 5_000, { bucket: 'clean' })],
    };
    const lifted = liftRecommendationByOutpoint(rec, [rich('aa', 9_000)]);
    expect(lifted.candidates.map((c) => c.txid)).toEqual(['aa']);
  });

  it('preserves a null recommendation instead of fabricating a coin', () => {
    const rec: FundingRecommendation<AnnotatedFundingUtxo> = {
      status: 'insufficient', recommended: null, candidates: [],
    };
    const lifted = liftRecommendationByOutpoint(rec, [rich('aa', 9_000)]);
    expect(lifted.recommended).toBeNull();
    expect(lifted.status).toBe('insufficient');
  });
});
