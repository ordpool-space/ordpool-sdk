import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import {
  BuildCat21BuyOfferArgs,
  buildCat21BuyOfferPsbt,
  validateCat21BuyOfferPsbt,
} from './cat21-offer.helper';
import { CAT21_OFFER_POSTAGE_SATS } from './cat21-offer.types';

const publicKey = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const p2wpkh = btc.p2wpkh(publicKey, btc.NETWORK);
// On testnet so we don't accidentally generate a mainnet address in tests:
const p2wpkhTestnet = btc.p2wpkh(publicKey, btc.TEST_NETWORK);

function makeBaseArgs(overrides: Partial<BuildCat21BuyOfferArgs> = {}): BuildCat21BuyOfferArgs {
  return {
    network: Network.Testnet3,
    sellerInput: {
      txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      vout: 0,
      value: 546,
      scriptPubKey: p2wpkhTestnet.script,
    },
    buyerInputs: [
      {
        txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        vout: 1,
        value: 50_000,
        scriptPubKey: p2wpkhTestnet.script,
      },
    ],
    destinations: {
      buyerReceiveAddress: p2wpkhTestnet.address!,
      sellerPaymentAddress: p2wpkhTestnet.address!,
      buyerChangeAddress: p2wpkhTestnet.address!,
    },
    priceSats: 21_000,
    feeSats: 1_000,
    ...overrides,
  };
}

describe('buildCat21BuyOfferPsbt', () => {

  it('produces a parseable PSBT', () => {
    const result = buildCat21BuyOfferPsbt(makeBaseArgs());
    const psbtMagic = [0x70, 0x73, 0x62, 0x74, 0xff];
    expect(Array.from(result.psbt.slice(0, 5))).toEqual(psbtMagic);
  });

  it('puts the seller input at index 0 with sighashType SIGHASH_ALL', () => {
    const args = makeBaseArgs();
    const tx = btc.Transaction.fromPSBT(buildCat21BuyOfferPsbt(args).psbt);
    const sellerInput = tx.getInput(0);
    expect(Array.from(sellerInput.txid!)).toEqual(Array.from(hex.decode(args.sellerInput.txid)));
    expect(sellerInput.index).toBe(args.sellerInput.vout);
    expect(sellerInput.sighashType).toBe(btc.SigHash.ALL);
    expect(sellerInput.partialSig).toBeUndefined();
    expect(sellerInput.tapKeySig).toBeUndefined();
  });

  it('places the cat at output 0 with the default postage', () => {
    const tx = btc.Transaction.fromPSBT(buildCat21BuyOfferPsbt(makeBaseArgs()).psbt);
    expect(tx.getOutput(0).amount).toBe(BigInt(CAT21_OFFER_POSTAGE_SATS));
  });

  it('places the seller payment at output 1 with priceSats', () => {
    const args = makeBaseArgs({ priceSats: 42_000 });
    const tx = btc.Transaction.fromPSBT(buildCat21BuyOfferPsbt(args).psbt);
    expect(tx.getOutput(1).amount).toBe(BigInt(42_000));
  });

  it('emits a change output when buyer change is above the dust floor', () => {
    // 50k buyer - (21k seller-payment + 546 postage - 546 recycled - 1k fee) = 28k change
    const result = buildCat21BuyOfferPsbt(makeBaseArgs());
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.outputsLength).toBe(3);
    expect(tx.getOutput(2).amount).toBe(BigInt(28_000));
    expect(result.changeSats).toBe(28_000);
  });

  it('absorbs sub-dust change into the miner fee instead of emitting an output', () => {
    // Tweak buyerInputs so change is exactly 100 sats.
    const args = makeBaseArgs({
      buyerInputs: [
        {
          txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
          vout: 1,
          value: 22_100,
          scriptPubKey: p2wpkhTestnet.script,
        },
      ],
    });
    const result = buildCat21BuyOfferPsbt(args);
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.outputsLength).toBe(2);
    expect(result.changeSats).toBe(0);
  });

  it('uses an override postage when supplied', () => {
    const args = makeBaseArgs({
      postageSats: 800,
      sellerInput: { ...makeBaseArgs().sellerInput, value: 800 },
    });
    const tx = btc.Transaction.fromPSBT(buildCat21BuyOfferPsbt(args).psbt);
    expect(tx.getOutput(0).amount).toBe(BigInt(800));
  });

  it('rejects non-positive priceSats', () => {
    expect(() => buildCat21BuyOfferPsbt(makeBaseArgs({ priceSats: 0 }))).toThrow(/priceSats/);
    expect(() => buildCat21BuyOfferPsbt(makeBaseArgs({ priceSats: -1 }))).toThrow(/priceSats/);
  });

  it('rejects postage below safe dust threshold', () => {
    expect(() => buildCat21BuyOfferPsbt(makeBaseArgs({ postageSats: 329 }))).toThrow(/dust/);
  });

  it('rejects empty buyerInputs', () => {
    expect(() => buildCat21BuyOfferPsbt(makeBaseArgs({ buyerInputs: [] }))).toThrow(/buyerInputs/);
  });

  it('rejects insufficient buyer funding', () => {
    const args = makeBaseArgs({
      priceSats: 100_000,
      // 50k buyer can never cover 100k price + 546 postage + 1k fee.
    });
    expect(() => buildCat21BuyOfferPsbt(args)).toThrow(/do not cover/);
  });

  it('respects tapInternalKey on taproot buyer inputs', () => {
    const taprootPayment = btc.p2tr(publicKey.slice(1, 33), undefined, btc.TEST_NETWORK);
    const args = makeBaseArgs({
      buyerInputs: [
        {
          txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
          vout: 1,
          value: 50_000,
          scriptPubKey: taprootPayment.script,
          tapInternalKey: publicKey.slice(1, 33),
        },
      ],
    });
    const tx = btc.Transaction.fromPSBT(buildCat21BuyOfferPsbt(args).psbt);
    const buyerInput = tx.getInput(1);
    expect(buyerInput.tapInternalKey).toBeDefined();
  });
});

describe('validateCat21BuyOfferPsbt', () => {

  it('accepts a freshly built PSBT with valid signed buyer inputs', () => {
    const args = makeBaseArgs();
    const built = buildCat21BuyOfferPsbt(args);
    // Inject a fake signature on the buyer input so validator passes the
    // "buyer must be signed" check. We don't validate signature bytes here,
    // just that the field is populated.
    const tx = btc.Transaction.fromPSBT(built.psbt);
    // Use a dummy partialSig pair: 33-byte pubkey + 71-byte sig.
    tx.updateInput(1, {
      partialSig: [[publicKey, new Uint8Array(71).fill(1)]],
    });
    const psbtWithSig = tx.toPSBT();

    const result = validateCat21BuyOfferPsbt({
      psbt: psbtWithSig,
      expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
      floorPriceSats: 21_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pricePaidSats).toBe(21_000);
      expect(result.postageSats).toBe(CAT21_OFFER_POSTAGE_SATS);
    }
  });

  it('rejects when the seller UTXO does not match', () => {
    const args = makeBaseArgs();
    const built = buildCat21BuyOfferPsbt(args);
    const result = validateCat21BuyOfferPsbt({
      psbt: built.psbt,
      expectedSellerUtxo: { txid: args.sellerInput.txid, vout: 99 },
      floorPriceSats: 21_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-seller-input');
  });

  it('rejects when price is below floor', () => {
    const args = makeBaseArgs({ priceSats: 21_000 });
    const built = buildCat21BuyOfferPsbt(args);
    const tx = btc.Transaction.fromPSBT(built.psbt);
    tx.updateInput(1, {
      partialSig: [[publicKey, new Uint8Array(71).fill(1)]],
    });
    const result = validateCat21BuyOfferPsbt({
      psbt: tx.toPSBT(),
      expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
      floorPriceSats: 21_001,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-price');
  });

  it('rejects when buyer input is unsigned', () => {
    const args = makeBaseArgs();
    const built = buildCat21BuyOfferPsbt(args);
    const result = validateCat21BuyOfferPsbt({
      psbt: built.psbt,
      expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
      floorPriceSats: 21_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('buyer-input-unsigned');
  });

  it('rejects when minPostageSats is overridden upward and the offer underpays', () => {
    const args = makeBaseArgs();
    const built = buildCat21BuyOfferPsbt(args);
    const tx = btc.Transaction.fromPSBT(built.psbt);
    tx.updateInput(1, {
      partialSig: [[publicKey, new Uint8Array(71).fill(1)]],
    });
    const result = validateCat21BuyOfferPsbt({
      psbt: tx.toPSBT(),
      expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
      floorPriceSats: 21_000,
      minPostageSats: 1_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-postage');
  });

  it('rejects a PSBT with no inputs', () => {
    const empty = new btc.Transaction({ allowUnknownInputs: true }).toPSBT();
    const result = validateCat21BuyOfferPsbt({
      psbt: empty,
      expectedSellerUtxo: { txid: '00'.repeat(32), vout: 0 },
      floorPriceSats: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-seller-input');
  });

  // Avoid unused `p2wpkh` warning when both networks are imported in setup.
  it('test setup compiles with mainnet payment helper', () => {
    expect(p2wpkh.script).toBeInstanceOf(Uint8Array);
  });
});
