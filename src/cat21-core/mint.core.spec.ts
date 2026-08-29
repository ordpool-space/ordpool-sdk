import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { BroadcastPort, ContentScanPort, CoreFundingUtxo, SignPort, UtxosPort } from './ports';
import { MintCoreParams, executeMint, simulateMint } from './mint.core';

// Plain NODE unit test — no Angular, no jsdom.

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
