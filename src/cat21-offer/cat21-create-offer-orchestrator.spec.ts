import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import {
  Cat21CreateOfferOrchestrator,
  CreateOfferOrchestratorDeps,
  CreateOfferSnapshot,
  CreateOfferWalletContext,
} from './cat21-create-offer-orchestrator';
import { BuyOfferTargetCat } from './cat21-offer.types';

// Node unit test — no Angular. Real keys so buildOffer/simulateCreateOffer
// actually build a PSBT. Pins the framework-agnostic create-offer (buyer bid)
// orchestration: state machine, safe-auto funding pick (funds price + cat REAL
// value + fee, ord parity), and createOffer()'s pre-signing guards. The signer
// happy-path needs a browser wallet provider → covered by the wallet-matrix e2e.

const PAYMENT_PUB = '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b';
const ORDINALS_XONLY = '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37';
const SELLER_XONLY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(hex.decode(ORDINALS_XONLY), undefined, btc.NETWORK).address!;
const SELLER_PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const SELLER_CAT_SCRIPT = btc.p2tr(hex.decode(SELLER_XONLY), undefined, btc.NETWORK).script;

const wallet: CreateOfferWalletContext = {
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: ORDINALS_ADDR,
  paymentAddress: PAYMENT_ADDR,
  paymentPublicKey: PAYMENT_PUB,
};

const targetCat: BuyOfferTargetCat = {
  catNumber: 42,
  txid: 'a'.repeat(64),
  vout: 0,
  value: 546,
  scriptPubKey: SELLER_CAT_SCRIPT,
};

const coin = (id: string, value: number): TxnOutput => ({
  txid: id.repeat(64).slice(0, 64),
  vout: 0,
  status: { confirmed: true },
  value,
});

const deps = (over: Partial<CreateOfferOrchestratorDeps> = {}): CreateOfferOrchestratorDeps => ({
  getUtxos: async () => [coin('c', 100_000)],
  scan: { classify: async () => 'clean' },
  network: Network.Mainnet,
  ...over,
});

function waitFor(
  o: Cat21CreateOfferOrchestrator,
  pred: (s: CreateOfferSnapshot) => boolean,
): Promise<CreateOfferSnapshot> {
  return new Promise((resolve) => {
    const unsub = o.subscribe((s) => {
      if (pred(s)) {
        unsub();
        resolve(s);
      }
    });
  });
}

/** Set every input a valid bid needs (buyerReceiveAddress defaults from wallet). */
function fillInputs(o: Cat21CreateOfferOrchestrator): void {
  o.setTargetCat(targetCat);
  o.setSellerPaymentAddress(SELLER_PAYMENT_ADDR);
  o.setPriceSats(21_000);
  o.setFeeRate(10);
}

describe('Cat21CreateOfferOrchestrator (framework-agnostic)', () => {
  it('starts idle', () => {
    expect(new Cat21CreateOfferOrchestrator(deps()).getSnapshot().state).toBe('idle');
  });

  it('setWallet fetches UTXOs, reaches ready, defaults buyerReceiveAddress to ordinals', async () => {
    const o = new Cat21CreateOfferOrchestrator(deps());
    await o.setWallet(wallet);
    expect(o.getSnapshot().state).toBe('ready');
    expect(o.getSnapshot().buyerReceiveAddress).toBe(ORDINALS_ADDR);
  });

  it('AUTO: clean coin + full inputs => a ready simulation with positive fee + change', async () => {
    const o = new Cat21CreateOfferOrchestrator(deps());
    await o.setWallet(wallet);
    fillInputs(o);
    const s = await waitFor(o, (s) => s.simulation !== null);
    expect(s.fundingRecommendation.status).toBe('auto');
    expect(s.simulation?.feeSats).toBeGreaterThan(0);
    expect(s.simulation?.changeSats).toBeGreaterThan(0);
    expect(s.simulation?.buyerFundingUtxo.txid).toBe(coin('c', 100_000).txid);
  });

  it('EXPERT-REQUIRED: only an asset coin => no simulation, createOffer() refuses', async () => {
    const o = new Cat21CreateOfferOrchestrator(
      deps({ getUtxos: async () => [coin('d', 100_000)], scan: { classify: async () => 'has-assets' } }),
    );
    await o.setWallet(wallet);
    fillInputs(o);
    const s = await waitFor(o, (s) => s.fundingRecommendation.status === 'expert-required');
    expect(s.simulation).toBeNull();
    await expect(o.createOffer()).rejects.toThrow(/Select a funding UTXO/);
  });

  it('createOffer() guards: no wallet / no target / no seller / no price / no feeRate', async () => {
    const o = new Cat21CreateOfferOrchestrator(deps());
    await expect(o.createOffer()).rejects.toThrow('No wallet connected');
    await o.setWallet(wallet);
    await expect(o.createOffer()).rejects.toThrow('No target cat selected');
    o.setTargetCat(targetCat);
    await expect(o.createOffer()).rejects.toThrow('No seller payment address');
    o.setSellerPaymentAddress(SELLER_PAYMENT_ADDR);
    await expect(o.createOffer()).rejects.toThrow('No price set');
    o.setPriceSats(21_000);
    await expect(o.createOffer()).rejects.toThrow('No fee rate set');
  });

  it('subscribe fires immediately then on change; unsubscribe stops it', async () => {
    const o = new Cat21CreateOfferOrchestrator(deps());
    const seen: string[] = [];
    const unsub = o.subscribe((s) => seen.push(s.state));
    expect(seen).toEqual(['idle']);
    await o.setWallet(wallet);
    expect(seen).toContain('ready');
    const n = seen.length;
    unsub();
    o.reset();
    expect(seen).toHaveLength(n);
  });
});
