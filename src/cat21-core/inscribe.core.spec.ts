import { describe, expect, it, jest } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import { BroadcastPort, ContentScanPort, CoreFundingUtxo, UtxosPort } from './ports.js';
import { InscribeCoreParams, executeInscribe, simulateInscribe } from './inscribe.core.js';

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
  it('the picker grid prices commit change against the PER-ADDRESS dust floor', async () => {
    // The real commit is built with getMinimumUtxoSize(paymentAddress)
    // (inscription.service.helper, inscribe-mint-orchestrator). Omitting it
    // here falls back to the postage value, and between that and the payer's
    // own floor the grid reports an over-pay on a coin whose change the signed
    // commit actually emits. bc1q is 294, postage is 546.
    //
    // Two points rather than one, so the band itself is pinned: a leftover
    // BELOW 294 must still fold into the fee, and one inside [294, 546) must
    // not. A flat-546 fallback folds both.
    const rowFor = async (value: number) => {
      const sim = await simulateInscribe(
        params(),
        { utxos: utxosPort([coin('c', value)]), scan: scanPort() },
      );
      return sim.candidateFees[0];
    };

    const probe = await simulateInscribe(
      params(),
      { utxos: utxosPort([coin('c', 200_000)]), scan: scanPort() },
    );
    const target = probe.fundingRequirementSats;
    if (target === null) throw new Error('the probe did not report a funding requirement');

    const belowFloor = await rowFor(target + 200);
    const insideBand = await rowFor(target + 400);

    expect(belowFloor.absorbedSubDustSats).toBeGreaterThan(0);
    expect(insideBand.absorbedSubDustSats).toBe(0);
  });


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

describe('inscribe.core — both funding targets are reachable', () => {
  // Same reason as the mint: a caller sizing a coin needs the headroom target
  // too, because a coin between the two is fundable in principle and skipped
  // whenever anything else clears headroom.
  it('reports the headroom target above the requirement', async () => {
    const sim = await simulateInscribe(params(), { utxos: utxosPort([coin('a', 500_000)]), scan: scanPort() });
    expect(sim.fundingRequirementSats).not.toBeNull();
    expect(sim.fundingPreferredSats).not.toBeNull();
    expect(sim.fundingPreferredSats!).toBeGreaterThan(sim.fundingRequirementSats!);
    // The gap is this payment address's dust floor: what a change output costs
    // to exist. Collapse it and the preference it encodes disappears.
    expect(sim.fundingPreferredSats! - sim.fundingRequirementSats!).toBeGreaterThanOrEqual(294);
  });

  it('reports both targets even with an EMPTY pool, because neither depends on it', async () => {
    // Unlike the mint, which measures against the largest available coin, the
    // inscribe target comes from the envelope and the fee rate alone. So a
    // caller can ask what it needs BEFORE funding anything, which is what a
    // page-driven spec wants when it is deciding what size coin to seed.
    const sim = await simulateInscribe(params(), { utxos: utxosPort([]), scan: scanPort() });
    expect(sim.status).toBe('insufficient');
    expect(sim.fundingRequirementSats).toBeGreaterThan(0);
    expect(sim.fundingPreferredSats!).toBeGreaterThan(sim.fundingRequirementSats!);
  });
});

describe('inscribe.core — an unmeasurable target says WHY', () => {
  // A caller cannot act on `insufficient` without knowing whether its COIN is
  // too small or its PARAMS are wrong, and those want opposite fixes. The bare
  // catch that used to sit here made both look identical.
  it('reports the reason when the params cannot produce a target', async () => {
    const sim = await simulateInscribe(
      // A payment address that is not a real address throws deep in address
      // handling, which is the shape a missing `network` also produces.
      { ...params(), paymentAddress: 'not-an-address' },
      { utxos: utxosPort([coin('a', 10_000_000)]), scan: scanPort() },
    );
    expect(sim.status).toBe('insufficient');
    expect(sim.fundingRequirementSats).toBeNull();
    expect(sim.fundingTargetError).toContain('could not measure the inscribe target');
    // And it points at the three things that actually cause it.
    expect(sim.fundingTargetError).toContain('network');
  });

  it('reports the reason for a non-positive fee rate rather than a bare null', async () => {
    const sim = await simulateInscribe(
      { ...params(), feeRatePerVbyte: 0 },
      { utxos: utxosPort([coin('a', 10_000_000)]), scan: scanPort() },
    );
    expect(sim.fundingTargetError).toContain('feeRatePerVbyte must be positive');
  });

  it('carries NO error on a healthy plan, so the field cannot be read as a warning', async () => {
    const sim = await simulateInscribe(params(), { utxos: utxosPort([coin('a', 500_000)]), scan: scanPort() });
    expect(sim.fundingTargetError).toBeNull();
    expect(sim.fundingRequirementSats).toBeGreaterThan(0);
  });
});
