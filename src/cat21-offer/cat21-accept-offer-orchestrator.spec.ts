import { secp256k1 } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { toPaymentAddress } from '../wallet/address-types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { buildCat21BuyOfferPsbt } from './cat21-offer.helper';
import { prepareBuyOfferBuyerInput } from './cat21-offer-input-adapter';
import {
  AcceptOfferOrchestratorDeps,
  AcceptOfferSnapshot,
  AcceptOfferWalletContext,
  Cat21AcceptOfferOrchestrator,
} from './cat21-accept-offer-orchestrator';

// Node unit test. Builds a REAL buyer-signed offer so the paste
// reaches `parsed`. Pins the framework-agnostic accept-offer orchestration:
// decode + validate state machine, the form-incomplete gate, and acceptOffer()'s
// pre-signing guards. The signer happy-path needs a browser wallet provider.
// NOTE: the wallet-matrix accept-offer specs drive validateCat21BuyOfferPsbt
// + the signer methods DIRECTLY, not this orchestrator — no e2e composes
// build → orchestrator → signer today. The orchestrator's own compose step
// is covered only by this unit spec.

const SELLER_KEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000002');
const SELLER_P2TR = btc.p2tr(SELLER_KEY.slice(1, 33), undefined, btc.NETWORK);
const SELLER_PAYMENT = btc.p2wpkh(SELLER_KEY, btc.NETWORK).address!;

const BUYER_PRIV = hex.decode('0101010101010101010101010101010101010101010101010101010101010101');
const BUYER_PUB = secp256k1.getPublicKey(BUYER_PRIV, true);
const BUYER_PAYMENT = btc.p2wpkh(BUYER_PUB, btc.NETWORK).address!;
const BUYER_RECEIVE = btc.p2tr(BUYER_PUB.slice(1, 33), undefined, btc.NETWORK).address!;

const CAT = { txid: 'a'.repeat(64), vout: 0, value: 546 };
const PRICE = 21_000;

function buildOfferBase64(): string {
  const buyerInput = prepareBuyOfferBuyerInput({
    utxo: { txid: 'b'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
    paymentPublicKey: BUYER_PUB,
    paymentAddress: BUYER_PAYMENT,
    isSimulation: false,
    network: Network.Mainnet,
  });
  const built = buildCat21BuyOfferPsbt({
    walletType: KnownOrdinalWalletType.cat21wallet,
    network: Network.Mainnet,
    sellerInput: { txid: CAT.txid, vout: CAT.vout, value: CAT.value, scriptPubKey: SELLER_P2TR.script },
    buyerInputs: [buyerInput],
    destinations: {
      buyerReceiveAddress: BUYER_RECEIVE,
      sellerPaymentAddress: SELLER_PAYMENT,
      buyerChangeAddress: BUYER_PAYMENT,
    },
    priceSats: PRICE,
    feeSats: 1_000,
  });
  const tx = btc.Transaction.fromPSBT(built.psbt);
  tx.signIdx(BUYER_PRIV, 1);
  return base64.encode(tx.toPSBT());
}

const wallet: AcceptOfferWalletContext = {
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: SELLER_P2TR.address!,
  ordinalsPublicKey: hex.encode(SELLER_KEY.slice(1, 33)),
};

const deps = (over: Partial<AcceptOfferOrchestratorDeps> = {}): AcceptOfferOrchestratorDeps => ({
  broadcast: async () => ({ txid: 'settle-txid', channel: 'mempool' }),
  network: Network.Mainnet,
  ...over,
});

/** Set the seller's intent so the validator runs (cat + payout address + floor). */
function fillIntent(o: Cat21AcceptOfferOrchestrator): void {
  o.setExpectedCatUtxo({ txid: CAT.txid, vout: CAT.vout });
  o.setExpectedSellerPaymentAddress(toPaymentAddress(SELLER_PAYMENT));
  o.setFloorPriceSats(PRICE);
}

describe('Cat21AcceptOfferOrchestrator (framework-agnostic)', () => {
  it('starts idle', () => {
    expect(new Cat21AcceptOfferOrchestrator(deps()).getSnapshot().state).toBe('idle');
  });

  it('garbage paste => invalid with malformed reason', () => {
    const o = new Cat21AcceptOfferOrchestrator(deps());
    fillIntent(o);
    o.setPastedOffer('not-a-psbt');
    const s = o.getSnapshot();
    expect(s.state).toBe('invalid');
    expect(s.validationResult?.ok).toBe(false);
  });

  it('oversize paste => invalid before decoding', () => {
    const o = new Cat21AcceptOfferOrchestrator(deps());
    fillIntent(o);
    o.setPastedOffer('cHNidP'.padEnd(Cat21AcceptOfferOrchestrator.MAX_PASTED_OFFER_BYTES + 1, 'A'));
    expect(o.getSnapshot().state).toBe('invalid');
    expect(o.getSnapshot().errorMessage).toMatch(/too large/);
  });

  it('form incomplete (no floor/cat/addr) => stays idle, never validates', () => {
    const o = new Cat21AcceptOfferOrchestrator(deps());
    o.setPastedOffer(buildOfferBase64());
    expect(o.getSnapshot().state).toBe('idle');
    expect(o.getSnapshot().validationResult).toBeNull();
  });

  it('valid buyer-signed offer + full intent => parsed with the paid price', () => {
    const o = new Cat21AcceptOfferOrchestrator(deps());
    fillIntent(o);
    o.setPastedOffer(buildOfferBase64());
    const s = o.getSnapshot();
    expect(s.state).toBe('parsed');
    expect(s.preview?.pricePaidSats).toBe(PRICE);
    expect(s.preview?.catUtxo.txid).toBe(CAT.txid);
  });

  it('floor above the offer price => invalid (wrong-price)', () => {
    const o = new Cat21AcceptOfferOrchestrator(deps());
    o.setExpectedCatUtxo({ txid: CAT.txid, vout: CAT.vout });
    o.setExpectedSellerPaymentAddress(toPaymentAddress(SELLER_PAYMENT));
    o.setFloorPriceSats(PRICE + 1);
    o.setPastedOffer(buildOfferBase64());
    const s = o.getSnapshot();
    expect(s.state).toBe('invalid');
    expect(s.validationResult?.ok).toBe(false);
  });

  it('acceptOffer() guards: no wallet / no validated offer', async () => {
    const o = new Cat21AcceptOfferOrchestrator(deps());
    await expect(o.acceptOffer()).rejects.toThrow('No wallet connected');
    o.setWallet(wallet);
    await expect(o.acceptOffer()).rejects.toThrow('No validated offer to accept');
  });

  it('subscribe fires immediately then on change; unsubscribe stops it', () => {
    const o = new Cat21AcceptOfferOrchestrator(deps());
    const seen: string[] = [];
    const unsub = o.subscribe((s) => seen.push(s.state));
    expect(seen).toEqual(['idle']);
    fillIntent(o);
    o.setPastedOffer(buildOfferBase64());
    expect(seen).toContain('parsed');
    const n = seen.length;
    unsub();
    o.reset();
    expect(seen).toHaveLength(n);
  });

  it('a wallet swap resets state + outcome fields, not just the form', () => {
    const o = new Cat21AcceptOfferOrchestrator(deps());
    o.setWallet(wallet);
    fillIntent(o);
    o.setPastedOffer(buildOfferBase64());
    expect(o.getSnapshot().state).toBe('parsed');
    // Swap to a different seller wallet (different ordinals address).
    const otherOrdinals = btc.p2tr(new Uint8Array(32).fill(7), undefined, btc.NETWORK).address!;
    o.setWallet({ ...wallet, ordinalsAddress: otherOrdinals });
    const s = o.getSnapshot();
    expect(s.state).toBe('idle');
    expect(s.preview).toBeNull();
    expect(s.successTxId).toBeNull();
    expect(s.errorMessage).toBeNull();
  });

  it('disableFloorGate keeps floor 0 across reset; a bot consumer re-requires an explicit floor', () => {
    const human = new Cat21AcceptOfferOrchestrator(deps());
    human.setWallet(wallet);
    human.disableFloorGate();
    expect(human.getSnapshot().floorPriceSats).toBe(0);
    human.reset();
    expect(human.getSnapshot().floorPriceSats).toBe(0); // opt-out persists

    const bot = new Cat21AcceptOfferOrchestrator(deps());
    bot.setWallet(wallet);
    bot.setFloorPriceSats(21_000);
    bot.reset();
    expect(bot.getSnapshot().floorPriceSats).toBeNull(); // the "explicit floor" gate re-arms
  });

  it('reset() returns to idle', () => {
    const o = new Cat21AcceptOfferOrchestrator(deps());
    o.setWallet(wallet);
    fillIntent(o);
    o.setPastedOffer(buildOfferBase64());
    expect(o.getSnapshot().state).toBe('parsed');
    o.reset();
    expect(o.getSnapshot().state).toBe('idle');
    expect(o.getSnapshot().preview).toBeNull();
  });

  it('acceptOffer() drives state:error when the wallet signer is unavailable', async () => {
    const o = new Cat21AcceptOfferOrchestrator(deps());
    o.setWallet(wallet);
    fillIntent(o);
    o.setPastedOffer(buildOfferBase64());
    expect(o.getSnapshot().state).toBe('parsed');
    // Valid parsed offer -> passes the guards, reaches the seller signer, which
    // has no browser provider in node -> the catch arm must fire.
    await expect(o.acceptOffer()).rejects.toThrow();
    expect(o.getSnapshot().state).toBe('error');
  });
});
