import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { ContentScanPort, CoreFundingUtxo, OfferCreateSignPort, UtxosPort } from './ports';
import { CreateOfferCoreParams, createOffer, simulateCreateOffer } from './create-offer.core';

// Plain NODE unit test — no Angular, no jsdom.

const BUYER_KEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const SELLER_KEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000002');
const BUYER_PAYMENT = btc.p2wpkh(BUYER_KEY, btc.NETWORK).address!;
const BUYER_RECEIVE = btc.p2tr(BUYER_KEY.slice(1, 33), undefined, btc.NETWORK).address!;
const SELLER_PAYMENT = btc.p2wpkh(SELLER_KEY, btc.NETWORK).address!;
const SELLER_CAT_SCRIPT = btc.p2tr(SELLER_KEY.slice(1, 33), undefined, btc.NETWORK).script;

const coin = (id: string, value: number): CoreFundingUtxo => ({ txid: id.repeat(64).slice(0, 64), vout: 0, value });
const op = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;

const params = (over: Partial<CreateOfferCoreParams> = {}): CreateOfferCoreParams => ({
  walletType: KnownOrdinalWalletType.cat21wallet,
  network: Network.Mainnet,
  paymentPublicKey: BUYER_KEY,
  paymentAddress: BUYER_PAYMENT,
  buyerReceiveAddress: BUYER_RECEIVE,
  sellerPaymentAddress: SELLER_PAYMENT,
  targetCat: { txid: 'a'.repeat(64), vout: 0, value: 546, scriptPubKey: SELLER_CAT_SCRIPT },
  priceSats: 21_000,
  feeRatePerVbyte: 10,
  ...over,
});

const utxosPort = (coins: CoreFundingUtxo[]): UtxosPort => ({ spendableUtxos: async () => coins });
const scanPort = (verdicts: Record<string, 'clean' | 'has-assets'> = {}): ContentScanPort => ({
  classify: async (outpoint) => verdicts[outpoint] ?? 'clean',
});
const signOfferPort = () => {
  const calls: number[][] = [];
  const port: OfferCreateSignPort = {
    signBuyerInputs: async (_psbt, indexes) => { calls.push(indexes); return new Uint8Array([0xba, 0x1d]); },
  };
  return { calls, port };
};

describe('create-offer.core — simulateCreateOffer', () => {
  it('AUTO: a clean covering coin => ready with change', async () => {
    const clean = coin('c', 100_000);
    const sim = await simulateCreateOffer(params(), { utxos: utxosPort([clean]), scan: scanPort() });
    expect(sim.status).toBe('ready');
    expect(sim.buyerFundingUtxo?.txid).toBe(clean.txid);
    expect(sim.changeSats).toBeGreaterThan(0);
    expect(sim.feeSats).toBeGreaterThan(0);
  });

  it('funds price + the cat REAL value + fee on a NON-546 cat (ord parity)', async () => {
    const clean = coin('c', 100_000);
    const sim = await simulateCreateOffer(params({ targetCat: { txid: 'a'.repeat(64), vout: 0, value: 9_000, scriptPubKey: SELLER_CAT_SCRIPT } }), {
      utxos: utxosPort([clean]),
      scan: scanPort(),
    });
    expect(sim.status).toBe('ready');
    // change + price + cat value (9000) + fee == funding, proving no 546 hardcode.
    expect((sim.changeSats ?? 0) + 21_000 + 9_000 + (sim.feeSats ?? 0)).toBe(100_000);
  });

  it('EXPERT-REQUIRED: only an asset coin covers', async () => {
    const asset = coin('d', 100_000);
    const sim = await simulateCreateOffer(params(), { utxos: utxosPort([asset]), scan: scanPort({ [op(asset)]: 'has-assets' }) });
    expect(sim.status).toBe('expert-required');
  });

  it('INSUFFICIENT: coin too small for price + cat + fee', async () => {
    const sim = await simulateCreateOffer(params(), { utxos: utxosPort([coin('c', 900)]), scan: scanPort() });
    expect(sim.status).toBe('insufficient');
  });
});

describe('create-offer.core — createOffer', () => {
  it('buyer-signs inputs [1] and returns the offer PSBT (no broadcast)', async () => {
    const signOffer = signOfferPort();
    const artifact = await createOffer(params(), {
      utxos: utxosPort([coin('c', 100_000)]),
      scan: scanPort(),
      signOffer: signOffer.port,
    });
    expect(signOffer.calls).toEqual([[1]]); // buyer input index; input 0 stays for the seller
    expect(Array.from(artifact.offerPsbt)).toEqual([0xba, 0x1d]);
    expect(artifact.feeSats).toBeGreaterThan(0);
  });

  it('EXPERT-REQUIRED: refuses, does not sign', async () => {
    const asset = coin('d', 100_000);
    const signOffer = signOfferPort();
    await expect(
      createOffer(params(), { utxos: utxosPort([asset]), scan: scanPort({ [op(asset)]: 'has-assets' }), signOffer: signOffer.port }),
    ).rejects.toThrow(/Select a funding UTXO/);
    expect(signOffer.calls).toHaveLength(0);
  });

  it('EXPERT OVERRIDE: an explicit pick of the asset coin is honoured', async () => {
    const asset = coin('d', 100_000);
    const signOffer = signOfferPort();
    const artifact = await createOffer(params({ selectedFundingUtxo: asset }), {
      utxos: utxosPort([asset]),
      scan: scanPort({ [op(asset)]: 'has-assets' }),
      signOffer: signOffer.port,
    });
    expect(signOffer.calls).toHaveLength(1);
    expect(artifact.buyerFundingUtxo.txid).toBe(asset.txid);
  });
});
