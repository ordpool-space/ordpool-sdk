import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { BroadcastPort, ContentScanPort, CoreFundingUtxo, SignPort, UtxosPort } from './ports';
import { MintCoreParams, executeMint, simulateMint } from './mint.core';

// Plain NODE unit test — no jsdom.

const PAYMENT_PUB = hex.decode('0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b');
const ORDINALS_PUB = hex.decode('5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37');
const PAYMENT_ADDR = btc.p2wpkh(PAYMENT_PUB, btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(ORDINALS_PUB, undefined, btc.NETWORK).address!;

const coin = (id: string, value: number): CoreFundingUtxo => ({ txid: id.repeat(64).slice(0, 64), vout: 0, value });
const op = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;

const params = (over: Partial<MintCoreParams> = {}): MintCoreParams => ({
  walletType: KnownOrdinalWalletType.cat21wallet,
  network: Network.Mainnet,
  paymentPublicKey: PAYMENT_PUB,
  paymentAddress: PAYMENT_ADDR,
  recipientAddress: ORDINALS_ADDR,
  feeRatePerVbyte: 10,
  ...over,
});

const utxosPort = (coins: CoreFundingUtxo[]): UtxosPort => ({ spendableUtxos: async () => coins });
const scanPort = (verdicts: Record<string, 'clean' | 'has-assets'> = {}): ContentScanPort => ({
  classify: async (outpoint) => verdicts[outpoint] ?? 'clean',
});
const signPort = () => {
  const calls: Array<'all' | number[]> = [];
  return { calls, port: { sign: async (_p: Uint8Array, i: 'all' | number[]) => { calls.push(i); return { hex: 'mintsigned', weight: 500 }; } } as SignPort };
};
const broadcastPort = () => {
  const calls: string[] = [];
  return { calls, port: { broadcast: async (h: string) => { calls.push(h); return { txid: 'mint-txid', channel: 'mempool' as const }; } } as BroadcastPort };
};

describe('mint.core — simulateMint', () => {
  it('AUTO: a clean covering coin => ready with a positive fee', async () => {
    const clean = coin('c', 100_000);
    const sim = await simulateMint(params(), { utxos: utxosPort([clean]), scan: scanPort() });
    expect(sim.status).toBe('ready');
    expect(sim.fundingUtxo?.txid).toBe(clean.txid);
    expect(sim.feeSats).toBeGreaterThan(0);
  });

  it('EXPERT-REQUIRED: only an asset coin covers', async () => {
    const asset = coin('d', 100_000);
    const sim = await simulateMint(params(), { utxos: utxosPort([asset]), scan: scanPort({ [op(asset)]: 'has-assets' }) });
    expect(sim.status).toBe('expert-required');
    expect(sim.fundingUtxo).toBeNull();
  });

  it('INSUFFICIENT: a coin too small for postage + fee', async () => {
    const sim = await simulateMint(params(), { utxos: utxosPort([coin('c', 600)]), scan: scanPort() });
    expect(sim.status).toBe('insufficient');
  });

  it('mints a "danger-band" coin the old fixed-200 ceiling wrongly rejected', async () => {
    // value 2200 < the old coverage target (546 + 200*10 = 2546), so the fixed
    // vB ceiling reported insufficient — but the coin fits a real mint (the
    // with-change fee's leftover is sub-dust, so it settles as no-change/absorb).
    const small = coin('c', 2200);
    const sim = await simulateMint(params({ feeRatePerVbyte: 10 }), { utxos: utxosPort([small]), scan: scanPort() });
    expect(sim.status).toBe('ready');
    expect(sim.fundingUtxo?.txid).toBe(small.txid);
    // Real fee, and never more than the coin's spendable surplus (no over-charge).
    expect(sim.feeSats!).toBeGreaterThan(0);
    expect(sim.feeSats!).toBeLessThanOrEqual(2200 - 546);
  });

  it('a coin below the true no-change floor is still insufficient (no false-mint)', async () => {
    const sim = await simulateMint(params({ feeRatePerVbyte: 10 }), { utxos: utxosPort([coin('c', 1000)]), scan: scanPort() });
    expect(sim.status).toBe('insufficient');
  });
});

describe('mint.core — executeMint', () => {
  it('signs "all" and broadcasts', async () => {
    const sign = signPort();
    const broadcast = broadcastPort();
    const out = await executeMint(params(), {
      utxos: utxosPort([coin('c', 100_000)]),
      scan: scanPort(),
      sign: sign.port,
      broadcast: broadcast.port,
    });
    expect(out).toMatchObject({ txid: 'mint-txid', channel: 'mempool' });
    expect(out.feeSats).toBeGreaterThan(0);
    expect(sign.calls).toEqual(['all']);
    expect(broadcast.calls).toEqual(['mintsigned']);
  });

  it('EXPERT-REQUIRED: refuses, does not sign', async () => {
    const asset = coin('d', 100_000);
    const sign = signPort();
    const broadcast = broadcastPort();
    await expect(
      executeMint(params(), { utxos: utxosPort([asset]), scan: scanPort({ [op(asset)]: 'has-assets' }), sign: sign.port, broadcast: broadcast.port }),
    ).rejects.toThrow(/Select a funding UTXO/);
    expect(sign.calls).toHaveLength(0);
  });

  it('EXPERT OVERRIDE: an explicit pick of the asset coin is honoured', async () => {
    const asset = coin('d', 100_000);
    const sign = signPort();
    const broadcast = broadcastPort();
    const out = await executeMint(params({ selectedFundingUtxo: asset }), {
      utxos: utxosPort([asset]),
      scan: scanPort({ [op(asset)]: 'has-assets' }),
      sign: sign.port,
      broadcast: broadcast.port,
    });
    expect(out.txid).toBe('mint-txid');
    expect(sign.calls).toHaveLength(1);
  });
});

describe('mint.core — change-headroom coin selection (dust-cliff over-pay guard)', () => {
  const RATE = 10;
  const FIXED = 546; // CAT21_POSTAGE_SATS (no tip): the mint's fixed output value.

  // ABSOLUTE-value true-positive-control (NOT self-calibrated): cat21-indexer's
  // real regtest pool. A self-calibrated test (below) sizes its coins from the
  // internal fee F, so it stays consistent-by-construction and would pass even
  // if `withChangeVsize` were wrongly measured as the no-change size. This
  // pins the fix against fixed sats + a fixed rate: pre-fix (best-fit, no
  // preferred target) picks the 13689 dust-cliff coin (vsize 122, rate ~107.73);
  // the fix must pick a headroom coin (99301/100000) with rate == 100.
  it('REGRESSION {13689, 99301, 100000} @ rate 100: picks a headroom coin, not the 13689 dust-cliff', async () => {
    const utxos = [coin('a', 13689), coin('b', 99301), coin('c', 100000)];
    const sim = await simulateMint(params({ feeRatePerVbyte: 100 }), { utxos: utxosPort(utxos), scan: scanPort() });
    expect(sim.status).toBe('ready');
    expect(sim.fundingUtxo?.value).not.toBe(13689);
    expect([99301, 100000]).toContain(sim.fundingUtxo?.value);
    expect(sim.vsize).toBe(153); // with-change (NOT the 122 no-change of the dust-cliff pick)
    expect(Math.abs(sim.feeSats! / sim.vsize! - 100)).toBeLessThan(1);
  });

  // Learn the with-change miner fee F = ceil(withChangeVsize * RATE) from a
  // large (headroom) coin, then build a coin whose budget lands in the
  // dust-cliff band [F, F + 546): its would-be change is sub-dust, so the
  // builder absorbs it into the fee → over-pay. A second coin has headroom.
  const learnF = async () => {
    const big = coin('a', 1_000_000);
    const s = await simulateMint(params({ feeRatePerVbyte: RATE }), { utxos: utxosPort([big]), scan: scanPort() });
    return s.feeSats!;
  };

  it('auto-picks the change-headroom coin so the realised fee-rate lands on the typed rate', async () => {
    const F = await learnF();
    const tight = coin('b', FIXED + F + 200); // budget F+200, in the dust-cliff band
    const headroom = coin('c', FIXED + F + 546 + 500); // budget clears the with-change fee + dust

    const sim = await simulateMint(params({ feeRatePerVbyte: RATE }), {
      utxos: utxosPort([tight, headroom]),
      scan: scanPort(),
    });
    expect(sim.status).toBe('ready');
    // Best-fit-by-value alone would take the SMALLER `tight` coin; the headroom
    // bias must skip it for `headroom` so an above-dust change is emitted.
    expect(sim.fundingUtxo?.txid).toBe(headroom.txid);
    const realisedRate = sim.feeSats! / sim.vsize!;
    expect(Math.abs(realisedRate - RATE)).toBeLessThan(1); // the over-pay is gone
  });

  it('FALLBACK: a tight-only wallet still MINTS (never a false insufficient), even though it over-pays', async () => {
    const F = await learnF();
    const tight = coin('b', FIXED + F + 200);
    const sim = await simulateMint(params({ feeRatePerVbyte: RATE }), { utxos: utxosPort([tight]), scan: scanPort() });
    expect(sim.status).toBe('ready'); // a doable mint is never rejected
    expect(sim.feeSats!).toBeGreaterThan(0);
    // This coin CANNOT avoid the over-pay (its sub-dust change is absorbed) —
    // proving the dust-cliff band is real and why the headroom pick matters.
    expect(sim.feeSats! / sim.vsize!).toBeGreaterThan(RATE);
  });
});
