import { describe, expect, it, jest } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { BroadcastPort, ContentScanPort, CoreFundingUtxo, UtxosPort } from './ports';
import { InscribeCoreParams, executeInscribe, simulateInscribe } from './inscribe.core';

// Plain NODE unit test — no jsdom.

const PAYMENT_PUB = hex.decode('0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b');
const ORDINALS_PUB = hex.decode('5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37');
const PAYMENT_ADDR = btc.p2wpkh(PAYMENT_PUB, btc.NETWORK).address!;
const RECIPIENT_ADDR = btc.p2tr(ORDINALS_PUB, undefined, btc.NETWORK).address!;

const coin = (id: string, value: number): CoreFundingUtxo => ({ txid: id.repeat(64).slice(0, 64), vout: 0, value });
const op = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;

const params = (over: Partial<InscribeCoreParams> = {}): InscribeCoreParams => ({
  walletType: KnownOrdinalWalletType.cat21wallet,
  network: Network.Mainnet,
  paymentPublicKey: PAYMENT_PUB,
  paymentAddress: PAYMENT_ADDR,
  recipientAddress: RECIPIENT_ADDR,
  body: new TextEncoder().encode('<html><!--cubes--></html>'),
  contentType: 'text/html;charset=utf-8',
  feeRatePerVbyte: 10,
  ...over,
});

const utxosPort = (coins: CoreFundingUtxo[]): UtxosPort => ({ spendableUtxos: async () => coins });
const scanPort = (verdicts: Record<string, 'clean' | 'has-assets'> = {}): ContentScanPort => ({
  classify: async (outpoint) => verdicts[outpoint] ?? 'clean',
});
const broadcastPort = (): BroadcastPort => ({ broadcast: async () => ({ txid: 'x', channel: 'mempool' }) });

describe('inscribe.core — simulateInscribe', () => {
  it('AUTO: a clean covering coin => ready with a positive funding requirement', async () => {
    const clean = coin('c', 200_000);
    const sim = await simulateInscribe(params(), { utxos: utxosPort([clean]), scan: scanPort() });
    expect(sim.status).toBe('ready');
    expect(sim.fundingUtxo?.txid).toBe(clean.txid);
    expect(sim.fundingRequirementSats).toBeGreaterThan(0);
  });

  it('mixed pool: a dust-cliff coin + a headroom coin => auto-picks the headroom coin (change-headroom)', async () => {
    // The funding requirement (with-change commit fee) is pool-independent
    // (simulated against a synthetic input), so learn it from a large coin.
    const target = (await simulateInscribe(params(), { utxos: utxosPort([coin('a', 500_000)]), scan: scanPort() }))
      .fundingRequirementSats!;
    // dust-cliff: covers the requirement but its 100-sat over-requirement is
    // below the P2WPKH change dust floor (294) => sub-dust commit change =>
    // absorbed into the fee (over-pay) IF picked.
    const dustCliff = coin('b', target + 100);
    // headroom: clears the requirement + the 294 floor comfortably.
    const headroom = coin('c', target + 2000);
    const sim = await simulateInscribe(params(), { utxos: utxosPort([dustCliff, headroom]), scan: scanPort() });
    expect(sim.status).toBe('ready');
    // Best-fit-by-value alone would take the SMALLER dust-cliff coin; the
    // preferred-target bias must skip it for the headroom coin.
    expect(sim.fundingUtxo?.value).toBe(target + 2000);
  });

  it('EXPERT-REQUIRED: only an asset coin covers', async () => {
    const asset = coin('d', 200_000);
    const sim = await simulateInscribe(params(), { utxos: utxosPort([asset]), scan: scanPort({ [op(asset)]: 'has-assets' }) });
    expect(sim.status).toBe('expert-required');
    expect(sim.fundingUtxo).toBeNull();
  });

  it('INSUFFICIENT: a coin too small for the commit requirement', async () => {
    const sim = await simulateInscribe(params(), { utxos: utxosPort([coin('c', 900)]), scan: scanPort() });
    expect(sim.status).toBe('insufficient');
  });
});

describe('inscribe.core — executeInscribe', () => {
  it('EXPERT-REQUIRED: refuses before touching the commit/reveal engine', async () => {
    const asset = coin('d', 200_000);
    await expect(
      executeInscribe(params(), {
        utxos: utxosPort([asset]),
        scan: scanPort({ [op(asset)]: 'has-assets' }),
        broadcast: broadcastPort(),
      }),
    ).rejects.toThrow(/Select a funding UTXO/);
  });

  it('drives the engine with the auto-picked coin (watch-only prompt fires)', async () => {
    // A watch-only (xpub) wallet reaches the commit signer via the prompt bridge.
    // That the prompt fires proves selection + delegation into inscribeAndBroadcast;
    // downstream finalize/broadcast may fail with the fake ports, which is fine.
    const prompt = jest.fn((u: { base64: string; hex: string }) => Promise.resolve(u.base64));
    await executeInscribe(params({ walletType: KnownOrdinalWalletType.xpub, paymentPublicKey: ORDINALS_PUB, paymentAddress: RECIPIENT_ADDR }), {
      utxos: utxosPort([coin('c', 200_000)]),
      scan: scanPort(),
      broadcast: broadcastPort(),
      promptForSignedPsbt: prompt,
    }).catch(() => undefined);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
