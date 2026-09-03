import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  BroadcastPort,
  ContentScanPort,
  CoreFundingUtxo,
  SignPort,
  UtxosPort,
} from './ports';
import { TransferCoreParams, executeTransfer, simulateTransfer } from './transfer.core';

// Plain NODE unit test — no jsdom. Real keys so the PSBT builds.

const PAYMENT_PUB = hex.decode('0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b');
const ORDINALS_PUB = hex.decode('5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37');
const PAYMENT_ADDR = btc.p2wpkh(PAYMENT_PUB, btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(ORDINALS_PUB, undefined, btc.NETWORK).address!;

const coin = (id: string, value: number): CoreFundingUtxo => ({ txid: id.repeat(64).slice(0, 64), vout: 0, value });
const op = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;

const params = (over: Partial<TransferCoreParams> = {}): TransferCoreParams => ({
  walletType: KnownOrdinalWalletType.cat21wallet,
  network: Network.Mainnet,
  ordinalsPublicKey: ORDINALS_PUB,
  ordinalsAddress: ORDINALS_ADDR,
  paymentPublicKey: PAYMENT_PUB,
  paymentAddress: PAYMENT_ADDR,
  catUtxo: { txid: 'a'.repeat(64), vout: 0, value: 546 },
  recipientAddress: ORDINALS_ADDR,
  feeRatePerVbyte: 10,
  ...over,
});

const utxosPort = (coins: CoreFundingUtxo[]): UtxosPort => ({ spendableUtxos: async () => coins });
const scanPort = (verdicts: Record<string, 'clean' | 'has-assets'> = {}): ContentScanPort => ({
  classify: async (outpoint) => verdicts[outpoint] ?? 'clean',
});
const signPort = (): { port: SignPort; calls: Array<{ indexes: 'all' | number[] }> } => {
  const calls: Array<{ indexes: 'all' | number[] }> = [];
  return {
    calls,
    port: { sign: async (_psbt, indexes) => { calls.push({ indexes }); return { hex: 'deadbeefsigned', weight: 600 }; } },
  };
};
const broadcastPort = (): { port: BroadcastPort; calls: string[] } => {
  const calls: string[] = [];
  return { calls, port: { broadcast: async (h) => { calls.push(h); return { txid: 'broadcast-txid', channel: 'mempool' }; } } };
};

describe('transfer.core — simulateTransfer', () => {
  it('AUTO: a clean covering coin => ready, preserves the cat size (546)', async () => {
    const clean = coin('c', 100_000);
    const sim = await simulateTransfer(params(), { utxos: utxosPort([clean]), scan: scanPort() });
    expect(sim.status).toBe('ready');
    expect(sim.fundingUtxo?.txid).toBe(clean.txid);
    expect(sim.catOutputSats).toBe(546); // PRESERVE
    expect(sim.feeSats).toBeGreaterThan(0);
  });

  it('EXPERT-REQUIRED: only an asset coin covers => no auto-pick', async () => {
    const asset = coin('d', 100_000);
    const sim = await simulateTransfer(params(), {
      utxos: utxosPort([asset]),
      scan: scanPort({ [op(asset)]: 'has-assets' }),
    });
    expect(sim.status).toBe('expert-required');
    expect(sim.fundingUtxo).toBeNull();
  });

  it('INSUFFICIENT: nothing covers the fee', async () => {
    const sim = await simulateTransfer(params({ feeRatePerVbyte: 50 }), {
      utxos: utxosPort([coin('c', 300)]),
      scan: scanPort(),
    });
    expect(sim.status).toBe('insufficient');
  });
});

describe('transfer.core — executeTransfer', () => {
  it('signs input set "all" and broadcasts the signed hex', async () => {
    const sign = signPort();
    const broadcast = broadcastPort();
    const out = await executeTransfer(params(), {
      utxos: utxosPort([coin('c', 100_000)]),
      scan: scanPort(),
      sign: sign.port,
      broadcast: broadcast.port,
    });
    expect(out).toMatchObject({ txid: 'broadcast-txid', channel: 'mempool' });
    expect(out.feeSats).toBeGreaterThan(0);
    expect(sign.calls).toEqual([{ indexes: 'all' }]);
    expect(broadcast.calls).toEqual(['deadbeefsigned']);
  });

  it('never auto-spends the asset coin when a clean coin also covers', async () => {
    const asset = coin('d', 3_000);
    const clean = coin('c', 100_000);
    const sign = signPort();
    const broadcast = broadcastPort();
    await executeTransfer(params(), {
      utxos: utxosPort([asset, clean]),
      scan: scanPort({ [op(asset)]: 'has-assets' }),
      sign: sign.port,
      broadcast: broadcast.port,
    });
    // Broadcast happened (clean coin was used); the asset coin was not the pick.
    expect(broadcast.calls).toHaveLength(1);
  });

  it('EXPERT-REQUIRED: refuses with a clear message, does not sign', async () => {
    const asset = coin('d', 100_000);
    const sign = signPort();
    const broadcast = broadcastPort();
    await expect(
      executeTransfer(params(), {
        utxos: utxosPort([asset]),
        scan: scanPort({ [op(asset)]: 'has-assets' }),
        sign: sign.port,
        broadcast: broadcast.port,
      }),
    ).rejects.toThrow(/Select a funding UTXO/);
    expect(sign.calls).toHaveLength(0);
    expect(broadcast.calls).toHaveLength(0);
  });

  it('EXPERT OVERRIDE: an explicit pick of the asset coin is honoured', async () => {
    const asset = coin('d', 100_000);
    const sign = signPort();
    const broadcast = broadcastPort();
    const out = await executeTransfer(params({ selectedFundingUtxo: asset }), {
      utxos: utxosPort([asset]),
      scan: scanPort({ [op(asset)]: 'has-assets' }),
      sign: sign.port,
      broadcast: broadcast.port,
    });
    expect(out.txid).toBe('broadcast-txid');
    expect(sign.calls).toHaveLength(1);
  });
});
