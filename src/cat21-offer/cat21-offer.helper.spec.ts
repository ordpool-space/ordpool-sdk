import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { attachDummyBuyerSig } from '../testing/fixtures';
import { toOrdinalsAddress, toPaymentAddress } from '../wallet/address-types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
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
    walletType: KnownOrdinalWalletType.cat21wallet,
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

  it('sets lockTime=21 (the offer tx is also a CAT-21 mint)', () => {
    const tx = btc.Transaction.fromPSBT(buildCat21BuyOfferPsbt(makeBaseArgs()).psbt);
    expect(tx.lockTime).toBe(21);
  });

  it('sets sequence=0xfffffffd on every input (RBF allowed for offers)', () => {
    // @scure/btc-signer's DEFAULT_SEQUENCE is 0xffffffff (final, RBF off);
    // the builder must override explicitly so non-mint cat-flows stay
    // fee-bumpable. Per cat21-wallet HARD RULE #1.
    const tx = btc.Transaction.fromPSBT(buildCat21BuyOfferPsbt(makeBaseArgs()).psbt);
    expect(tx.inputsLength).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < tx.inputsLength; i++) {
      expect(tx.getInput(i).sequence).toBe(0xfffffffd);
    }
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

  it('places the seller payment at output 1 with priceSats + postage (ord-parity; seller made whole on the 546 they contributed via input 0)', () => {
    const args = makeBaseArgs({ priceSats: 42_000 });
    const tx = btc.Transaction.fromPSBT(buildCat21BuyOfferPsbt(args).psbt);
    expect(tx.getOutput(1).amount).toBe(BigInt(42_000 + CAT21_OFFER_POSTAGE_SATS));
  });

  it('emits a change output when buyer change is above the dust floor', () => {
    // Buyer 50k. Obligation = priceSats (21k) + 2*postage (1092) - sellerInput (546) + fee (1k)
    //                       = 22 546. Change = 50_000 - 22_546 = 27_454.
    const result = buildCat21BuyOfferPsbt(makeBaseArgs());
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.outputsLength).toBe(3);
    expect(tx.getOutput(2).amount).toBe(BigInt(27_454));
    expect(result.changeSats).toBe(27_454);
  });

  it('absorbs sub-dust change into the miner fee instead of emitting an output', () => {
    // Obligation = 22_546 (see above). Buyer 22_646 → change 100 (sub-dust, absorbed).
    const args = makeBaseArgs({
      buyerInputs: [
        {
          txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
          vout: 1,
          value: 22_646,
          scriptPubKey: p2wpkhTestnet.script,
        },
      ],
    });
    const result = buildCat21BuyOfferPsbt(args);
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.outputsLength).toBe(2);
    expect(result.changeSats).toBe(0);
  });

  it('rejects non-positive priceSats', () => {
    expect(() => buildCat21BuyOfferPsbt(makeBaseArgs({ priceSats: 0 }))).toThrow(/priceSats/);
    expect(() => buildCat21BuyOfferPsbt(makeBaseArgs({ priceSats: -1 }))).toThrow(/priceSats/);
  });

  it('rejects sellerInput.value != 546 (HARD RULE: cat UTXO is always 546)', () => {
    expect(() => buildCat21BuyOfferPsbt(makeBaseArgs({
      sellerInput: { ...makeBaseArgs().sellerInput, value: 800 },
    }))).toThrow(/CAT21_POSTAGE_SATS|546/);
    expect(() => buildCat21BuyOfferPsbt(makeBaseArgs({
      sellerInput: { ...makeBaseArgs().sellerInput, value: 330 },
    }))).toThrow(/CAT21_POSTAGE_SATS|546/);
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
      expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
      network: Network.Testnet3,
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
      expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
      network: Network.Testnet3,
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
      expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
      network: Network.Testnet3,
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
      expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
      network: Network.Testnet3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('buyer-input-unsigned');
  });

  it('rejects when Output 0 postage is not exactly 546 (HARD RULE)', () => {
    // Build a PSBT by hand with cat output at 500 sats. Inputs first,
    // then outputs, THEN sign — scure refuses input mutations after any
    // signature is attached.
    const args = makeBaseArgs();
    const tx = new btc.Transaction({ allowUnknownInputs: true, lockTime: 21 });
    tx.addInput({
      txid: args.sellerInput.txid,
      index: args.sellerInput.vout,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2wpkhTestnet.script, amount: BigInt(CAT21_OFFER_POSTAGE_SATS) },
      sighashType: btc.SigHash.ALL,
    });
    tx.addInput({
      txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      index: 1,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2wpkhTestnet.script, amount: BigInt(50_000) },
      sighashType: btc.SigHash.ALL,
    });
    tx.addOutputAddress(p2wpkhTestnet.address!, BigInt(500), btc.TEST_NETWORK); // wrong postage
    tx.addOutputAddress(p2wpkhTestnet.address!, BigInt(21_546), btc.TEST_NETWORK);
    tx.updateInput(1, { partialSig: [[publicKey, new Uint8Array(71).fill(1)]] });
    const result = validateCat21BuyOfferPsbt({
      psbt: tx.toPSBT(),
      expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
      floorPriceSats: 21_000,
      expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
      network: Network.Testnet3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-postage');
  });

  it('rejects a non-PSBT blob (magic-byte mismatch) as malformed-offer-psbt', () => {
    const notAPsbt = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00]);
    const result = validateCat21BuyOfferPsbt({
      psbt: notAPsbt,
      expectedSellerUtxo: { txid: '00'.repeat(32), vout: 0 },
      floorPriceSats: 1,
      expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
      network: Network.Testnet3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed-offer-psbt');
  });

  it('rejects a PSBT with no inputs as malformed (not a seller-input problem)', () => {
    const empty = new btc.Transaction({ allowUnknownInputs: true, lockTime: 21 }).toPSBT();
    const result = validateCat21BuyOfferPsbt({
      psbt: empty,
      expectedSellerUtxo: { txid: '00'.repeat(32), vout: 0 },
      floorPriceSats: 1,
      expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
      network: Network.Testnet3,
    });
    expect(result.ok).toBe(false);
    // A PSBT with no inputs is a malformed artifact, not a "the seller's
    // input isn't the one I expected" case — those are distinct reasons.
    if (!result.ok) expect(result.reason).toBe('malformed-offer-psbt');
  });

  // Avoid unused `p2wpkh` warning when both networks are imported in setup.
  it('test setup compiles with mainnet payment helper', () => {
    expect(p2wpkh.script).toBeInstanceOf(Uint8Array);
  });

  describe('payment-output address gate (Finding #1)', () => {

    const attachBuyerSig = (psbtBytes: Uint8Array) => attachDummyBuyerSig(psbtBytes, publicKey);

    it('accepts when expectedSellerPaymentAddress matches Output 1 (testnet P2WPKH)', () => {
      const args = makeBaseArgs();
      const built = buildCat21BuyOfferPsbt(args);
      const result = validateCat21BuyOfferPsbt({
        psbt: attachBuyerSig(built.psbt),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 21_000,
        expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
        network: Network.Testnet3,
      });
      expect(result.ok).toBe(true);
    });

    it('rejects when Output 1 pays a different address than expected', () => {
      const args = makeBaseArgs({
        destinations: {
          ...makeBaseArgs().destinations,
          sellerPaymentAddress: p2wpkhTestnet.address!,
        },
      });
      const built = buildCat21BuyOfferPsbt(args);
      // Caller expected a DIFFERENT address. PSBT pays p2wpkhTestnet; we
      // expect the (also-testnet) taproot pubkey-derived address.
      const taproot = btc.p2tr(publicKey.slice(1, 33), undefined, btc.TEST_NETWORK);
      const result = validateCat21BuyOfferPsbt({
        psbt: attachBuyerSig(built.psbt),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 21_000,
        expectedSellerPaymentAddress: toPaymentAddress(taproot.address!),
        network: Network.Testnet3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('payment-output-wrong-address');
        // Detail contains BOTH addresses for auditability.
        expect(result.detail).toContain(taproot.address!);
        expect(result.detail).toContain(p2wpkhTestnet.address!);
      }
    });

    it('pass-through: when expectedSellerPaymentAddress is omitted, address is not checked', () => {
      const args = makeBaseArgs();
      const built = buildCat21BuyOfferPsbt(args);
      const result = validateCat21BuyOfferPsbt({
        psbt: attachBuyerSig(built.psbt),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 21_000,
        expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
        network: Network.Testnet3,
      });
      expect(result.ok).toBe(true);
    });

    it('per-address-type: accepts P2WPKH match (bc1q…)', () => {
      const mainPay = btc.p2wpkh(publicKey, btc.NETWORK);
      const seller = btc.p2wpkh(publicKey, btc.NETWORK);
      const buyer = btc.p2wpkh(publicKey, btc.NETWORK);
      const args = makeBaseArgs({
        network: Network.Mainnet,
        sellerInput: { ...makeBaseArgs().sellerInput, scriptPubKey: seller.script },
        buyerInputs: [
          {
            txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
            vout: 1,
            value: 50_000,
            scriptPubKey: buyer.script,
          },
        ],
        destinations: {
          buyerReceiveAddress: buyer.address!,
          sellerPaymentAddress: mainPay.address!,
          buyerChangeAddress: buyer.address!,
        },
      });
      const built = buildCat21BuyOfferPsbt(args);
      const result = validateCat21BuyOfferPsbt({
        psbt: attachBuyerSig(built.psbt),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 21_000,
        expectedSellerPaymentAddress: toPaymentAddress(mainPay.address!),
        network: Network.Mainnet,
      });
      expect(result.ok).toBe(true);
    });

    it('per-address-type: accepts P2TR match (bc1p…)', () => {
      const taproot = btc.p2tr(publicKey.slice(1, 33), undefined, btc.NETWORK);
      const buyer = btc.p2wpkh(publicKey, btc.NETWORK);
      const args = makeBaseArgs({
        network: Network.Mainnet,
        sellerInput: { ...makeBaseArgs().sellerInput, scriptPubKey: taproot.script },
        buyerInputs: [
          {
            txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
            vout: 1,
            value: 50_000,
            scriptPubKey: buyer.script,
          },
        ],
        destinations: {
          buyerReceiveAddress: buyer.address!,
          sellerPaymentAddress: taproot.address!,
          buyerChangeAddress: buyer.address!,
        },
      });
      const built = buildCat21BuyOfferPsbt(args);
      const result = validateCat21BuyOfferPsbt({
        psbt: attachBuyerSig(built.psbt),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 21_000,
        expectedSellerPaymentAddress: toPaymentAddress(taproot.address!),
        network: Network.Mainnet,
      });
      expect(result.ok).toBe(true);
    });

    it('network-aware: same pubkey on mainnet vs testnet does NOT match', () => {
      // PSBT pays the testnet address; caller expected the mainnet form.
      const args = makeBaseArgs();
      const built = buildCat21BuyOfferPsbt(args);
      const result = validateCat21BuyOfferPsbt({
        psbt: attachBuyerSig(built.psbt),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 21_000,
        expectedSellerPaymentAddress: toPaymentAddress(p2wpkh.address!), // mainnet bc1q…
        network: Network.Testnet3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('payment-output-wrong-address');
    });

    it('rejects with detail "scriptPubKey not decodable to address" when Output 1 script is missing', () => {
      // Build a normal PSBT, then surgically replace Output 1 with an
      // empty-script output post-finalisation using fromPSBT/round-trip.
      // The PSBT format permits empty scripts; the validator must reject
      // them with the typed reason.
      const args = makeBaseArgs();
      const built = buildCat21BuyOfferPsbt(args);
      // Decode → mutate Output 1 → re-encode by writing raw PSBT bytes is
      // out of scope. Easier: construct from scratch with no partialSig,
      // then add the sig via updateInput AFTER addOutput.
      const tx = new btc.Transaction({ lockTime: 21,
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      });
      tx.addInput({
        txid: args.sellerInput.txid,
        index: args.sellerInput.vout,
        witnessUtxo: { script: p2wpkhTestnet.script, amount: BigInt(546) },
        sighashType: btc.SigHash.ALL,
      });
      tx.addInput({
        txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        index: 1,
        witnessUtxo: { script: p2wpkhTestnet.script, amount: BigInt(50_000) },
        sighashType: btc.SigHash.ALL,
      });
      tx.addOutputAddress(p2wpkhTestnet.address!, BigInt(546), btc.TEST_NETWORK);
      tx.addOutput({ script: new Uint8Array(), amount: BigInt(21_000) });
      tx.updateInput(1, {
        partialSig: [[publicKey, new Uint8Array(71).fill(1)]],
      });
      const result = validateCat21BuyOfferPsbt({
        psbt: tx.toPSBT(),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 21_000,
        expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
        network: Network.Testnet3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('payment-output-wrong-address');
        expect(result.detail).toContain('scriptPubKey not decodable to address');
      }
      void built;
    });

    it('rejects with detail "scriptPubKey not decodable to address" when Output 1 carries an unaddressable script (OP_RETURN)', () => {
      const args = makeBaseArgs();
      const tx = new btc.Transaction({ lockTime: 21,
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      });
      tx.addInput({
        txid: args.sellerInput.txid,
        index: args.sellerInput.vout,
        witnessUtxo: { script: p2wpkhTestnet.script, amount: BigInt(546) },
        sighashType: btc.SigHash.ALL,
      });
      tx.addInput({
        txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        index: 1,
        witnessUtxo: { script: p2wpkhTestnet.script, amount: BigInt(50_000) },
        sighashType: btc.SigHash.ALL,
      });
      tx.addOutputAddress(p2wpkhTestnet.address!, BigInt(546), btc.TEST_NETWORK);
      // OP_RETURN script: 0x6a 0x00 — decodable, but Address(...).encode
      // rejects 'unknown' / data-carrier outputs.
      tx.addOutput({ script: new Uint8Array([0x6a, 0x00]), amount: BigInt(21_000) });
      tx.updateInput(1, {
        partialSig: [[publicKey, new Uint8Array(71).fill(1)]],
      });
      const result = validateCat21BuyOfferPsbt({
        psbt: tx.toPSBT(),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 21_000,
        expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
        network: Network.Testnet3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('payment-output-wrong-address');
        expect(result.detail).toContain('scriptPubKey not decodable to address');
      }
    });

    it('per-address-type: accepts P2SH match (wrapped segwit, 3…)', () => {
      const p2wpkhInner = btc.p2wpkh(publicKey, btc.NETWORK);
      const p2sh = btc.p2sh(p2wpkhInner, btc.NETWORK);
      const buyer = btc.p2wpkh(publicKey, btc.NETWORK);
      const args = makeBaseArgs({
        network: Network.Mainnet,
        sellerInput: { ...makeBaseArgs().sellerInput, scriptPubKey: p2sh.script },
        buyerInputs: [
          {
            txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
            vout: 1,
            value: 50_000,
            scriptPubKey: buyer.script,
          },
        ],
        destinations: {
          buyerReceiveAddress: buyer.address!,
          sellerPaymentAddress: p2sh.address!,
          buyerChangeAddress: buyer.address!,
        },
      });
      const built = buildCat21BuyOfferPsbt(args);
      const tx = btc.Transaction.fromPSBT(built.psbt);
      tx.updateInput(1, { partialSig: [[publicKey, new Uint8Array(71).fill(1)]] });
      const result = validateCat21BuyOfferPsbt({
        psbt: tx.toPSBT(),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 21_000,
        expectedSellerPaymentAddress: toPaymentAddress(p2sh.address!),
        network: Network.Mainnet,
      });
      expect(result.ok).toBe(true);
    });

    it('per-address-type: accepts P2WPKH match on regtest (bcrt1q…)', () => {
      // Regtest's HRP is `bcrt`, distinct from mainnet `bc` and testnet `tb`.
      // The validator round-trips Output 1's script through
      // `btc.Address(REGTEST_NETWORK).encode(...)`, so the regtest network
      // mapping at `network.ts` must produce a `bcrt1q…` string that matches
      // the address we built the PSBT against.
      const regtestNet = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
      const regtestPay = btc.p2wpkh(publicKey, regtestNet);
      const args = makeBaseArgs({
        network: Network.Regtest,
        sellerInput: { ...makeBaseArgs().sellerInput, scriptPubKey: regtestPay.script },
        buyerInputs: [
          {
            txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
            vout: 1,
            value: 50_000,
            scriptPubKey: regtestPay.script,
          },
        ],
        destinations: {
          buyerReceiveAddress: regtestPay.address!,
          sellerPaymentAddress: regtestPay.address!,
          buyerChangeAddress: regtestPay.address!,
        },
      });
      const built = buildCat21BuyOfferPsbt(args);
      const tx = btc.Transaction.fromPSBT(built.psbt);
      tx.updateInput(1, { partialSig: [[publicKey, new Uint8Array(71).fill(1)]] });
      const result = validateCat21BuyOfferPsbt({
        psbt: tx.toPSBT(),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 21_000,
        expectedSellerPaymentAddress: toPaymentAddress(regtestPay.address!),
        network: Network.Regtest,
      });
      expect(result.ok).toBe(true);
    });

    it('surfaces payment-output-wrong-address BEFORE wrong-price when both would fail', () => {
      // The address attack is more dangerous than the price one, so it
      // must surface first. PSBT pays the wrong address AND below floor.
      const args = makeBaseArgs();
      const built = buildCat21BuyOfferPsbt(args);
      const taproot = btc.p2tr(publicKey.slice(1, 33), undefined, btc.TEST_NETWORK);
      const tx = btc.Transaction.fromPSBT(built.psbt);
      tx.updateInput(1, { partialSig: [[publicKey, new Uint8Array(71).fill(1)]] });
      const result = validateCat21BuyOfferPsbt({
        psbt: tx.toPSBT(),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 1_000_000, // PSBT pays only 21k, would trip wrong-price.
        expectedSellerPaymentAddress: toPaymentAddress(taproot.address!), // also wrong address.
        network: Network.Testnet3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('payment-output-wrong-address');
    });
  });

  describe('Finding #2 — sellerInput.value enforced exactly at CAT21_POSTAGE_SATS', () => {

    it('builder rejects when seller UTXO value is below 546 (cat UTXO must be 546)', () => {
      expect(() =>
        buildCat21BuyOfferPsbt(
          makeBaseArgs({
            sellerInput: { ...makeBaseArgs().sellerInput, value: 100 },
          })
        )
      ).toThrow(/CAT21_POSTAGE_SATS|546/);
    });
  });

  describe('Finding #3 — sighash-not-all reject branch', () => {

    it('rejects PSBT with non-ALL sighashType on any input', () => {
      const args = makeBaseArgs();
      const built = buildCat21BuyOfferPsbt(args);
      const tx = btc.Transaction.fromPSBT(built.psbt);
      tx.updateInput(0, { sighashType: btc.SigHash.SINGLE });
      tx.updateInput(1, { partialSig: [[publicKey, new Uint8Array(71).fill(1)]] });
      const result = validateCat21BuyOfferPsbt({
        psbt: tx.toPSBT(),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 21_000,
        expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
        network: Network.Testnet3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('sighash-not-all');
    });
  });

  describe('Finding #4 — missing-seller-payment-output reject branch', () => {

    it('rejects a PSBT with fewer than 2 outputs', () => {
      const args = makeBaseArgs();
      const tx = new btc.Transaction({ allowUnknownInputs: true, lockTime: 21 });
      tx.addInput({
        txid: args.sellerInput.txid,
        index: args.sellerInput.vout,
        witnessUtxo: { script: p2wpkhTestnet.script, amount: BigInt(1000) },
        sighashType: btc.SigHash.ALL,
      });
      tx.addOutputAddress(p2wpkhTestnet.address!, BigInt(546), btc.TEST_NETWORK);
      const result = validateCat21BuyOfferPsbt({
        psbt: tx.toPSBT(),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 1,
        expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
        network: Network.Testnet3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('missing-seller-payment-output');
    });

    it('pins outputs-length check BEFORE seller-utxo check', () => {
      // The previous test's PSBT happens to satisfy the seller-utxo gate, so
      // swapping the two gate positions wouldn't break it. Disentangle:
      // build a 1-output PSBT whose Input 0 also points at the WRONG seller
      // txid. Both gates would fail; the typed reason must be the earlier
      // one. If a future refactor reorders the gates, this test surfaces it
      // as `missing-seller-input` instead of `missing-seller-payment-output`
      // and fails loudly.
      const args = makeBaseArgs();
      const wrongTxid = '0000000000000000000000000000000000000000000000000000000000000099';
      const tx = new btc.Transaction({ allowUnknownInputs: true, lockTime: 21 });
      tx.addInput({
        txid: wrongTxid,
        index: 99,
        witnessUtxo: { script: p2wpkhTestnet.script, amount: BigInt(1000) },
        sighashType: btc.SigHash.ALL,
      });
      tx.addOutputAddress(p2wpkhTestnet.address!, BigInt(546), btc.TEST_NETWORK);
      const result = validateCat21BuyOfferPsbt({
        psbt: tx.toPSBT(),
        expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
        floorPriceSats: 1,
        expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
        network: Network.Testnet3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('missing-seller-payment-output');
    });
  });

  describe('Finding #5 — change dust threshold boundary', () => {

    it('emits change output at exactly 546 sats (boundary)', () => {
      // Obligation = 21_000 (price) + 2*546 (postage on cat output + postage compensation on seller) - 546 (sellerInput) + 1_000 (fee) = 22_546.
      // Buyer 23_092 - 22_546 obligation = 546 change → emit.
      const result = buildCat21BuyOfferPsbt(
        makeBaseArgs({
          buyerInputs: [
            {
              txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
              vout: 1,
              value: 23_092,
              scriptPubKey: p2wpkhTestnet.script,
            },
          ],
        })
      );
      expect(result.changeSats).toBe(546);
      expect(btc.Transaction.fromPSBT(result.psbt).outputsLength).toBe(3);
    });

    it('absorbs 293 sats change into fee (just below P2WPKH dust of 294)', () => {
      // Default buyerChangeAddress is P2WPKH → dust=294. Buyer 22_839
      // - 22_546 obligation = 293 change → sub-P2WPKH-dust → absorbed.
      const result = buildCat21BuyOfferPsbt(
        makeBaseArgs({
          buyerInputs: [
            {
              txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
              vout: 1,
              value: 22_839,
              scriptPubKey: p2wpkhTestnet.script,
            },
          ],
        })
      );
      expect(result.changeSats).toBe(0);
      expect(btc.Transaction.fromPSBT(result.psbt).outputsLength).toBe(2);
    });
  });

  describe('Finding #13 — per-address-type dust floor for buyerChangeAddress', () => {

    // Pre-fix the builder hardcoded 546 as the change dust floor, so a
    // P2TR buyer with change in [330, 546) lost the whole change output
    // to the miner fee silently. Fix derives the floor from the
    // buyerChangeAddress script type via getMinimumUtxoSize (P2TR=330,
    // P2WPKH=294, P2SH=546, P2PKH=546).

    const p2trTestnet = btc.p2tr(publicKey.slice(1, 33), undefined, btc.TEST_NETWORK);

    it('P2TR buyerChangeAddress: emits change at 330 sats (previously absorbed)', () => {
      // Buyer 22_876 - 22_546 obligation = 330 change. P2TR dust = 330 → emit.
      const result = buildCat21BuyOfferPsbt(
        makeBaseArgs({
          destinations: {
            buyerReceiveAddress: p2wpkhTestnet.address!,
            sellerPaymentAddress: p2wpkhTestnet.address!,
            buyerChangeAddress: p2trTestnet.address!,
          },
          buyerInputs: [
            {
              txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
              vout: 1,
              value: 22_876,
              scriptPubKey: p2wpkhTestnet.script,
            },
          ],
        })
      );
      expect(result.changeSats).toBe(330);
      expect(btc.Transaction.fromPSBT(result.psbt).outputsLength).toBe(3);
    });

    it('P2TR buyerChangeAddress: absorbs 329 sats change into fee (just below P2TR dust)', () => {
      // Buyer 22_875 - 22_546 obligation = 329 change → sub-P2TR-dust → absorbed.
      const result = buildCat21BuyOfferPsbt(
        makeBaseArgs({
          destinations: {
            buyerReceiveAddress: p2wpkhTestnet.address!,
            sellerPaymentAddress: p2wpkhTestnet.address!,
            buyerChangeAddress: p2trTestnet.address!,
          },
          buyerInputs: [
            {
              txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
              vout: 1,
              value: 22_875,
              scriptPubKey: p2wpkhTestnet.script,
            },
          ],
        })
      );
      expect(result.changeSats).toBe(0);
      expect(btc.Transaction.fromPSBT(result.psbt).outputsLength).toBe(2);
    });

    it('P2WPKH buyerChangeAddress: emits change at 294 sats (previously absorbed)', () => {
      // Buyer 22_840 - 22_546 obligation = 294 change. P2WPKH dust = 294 → emit.
      const result = buildCat21BuyOfferPsbt(
        makeBaseArgs({
          destinations: {
            buyerReceiveAddress: p2wpkhTestnet.address!,
            sellerPaymentAddress: p2wpkhTestnet.address!,
            buyerChangeAddress: p2wpkhTestnet.address!,
          },
          buyerInputs: [
            {
              txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
              vout: 1,
              value: 22_840,
              scriptPubKey: p2wpkhTestnet.script,
            },
          ],
        })
      );
      expect(result.changeSats).toBe(294);
      expect(btc.Transaction.fromPSBT(result.psbt).outputsLength).toBe(3);
    });
  });

  describe('Finding #6 — result.hex parseability', () => {

    it('returns result.hex as parseable raw transaction bytes', () => {
      const result = buildCat21BuyOfferPsbt(makeBaseArgs());
      const parsed = btc.Transaction.fromRaw(hex.decode(result.hex), {
        allowUnknownOutputs: false,
      });
      expect(parsed.inputsLength).toBeGreaterThanOrEqual(2);
      expect(parsed.outputsLength).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Finding #7 — result.buyerInputTotalSats', () => {

    it('returns buyerInputTotalSats summing all buyer-funded inputs', () => {
      const result = buildCat21BuyOfferPsbt(
        makeBaseArgs({
          buyerInputs: [
            {
              txid: 'aa'.repeat(32),
              vout: 0,
              value: 30_000,
              scriptPubKey: p2wpkhTestnet.script,
            },
            {
              txid: 'bb'.repeat(32),
              vout: 1,
              value: 20_000,
              scriptPubKey: p2wpkhTestnet.script,
            },
          ],
        })
      );
      expect(result.buyerInputTotalSats).toBe(50_000);
    });
  });

  describe('Finding #15 — marketplace-side expected* args', () => {

    // The three optional args let a marketplace indexer (cat21-indexer's
    // BidsService today, any future consumer) delegate the "does the
    // PSBT match the DTO the buyer sent" check to the SDK validator
    // instead of maintaining its own parallel implementation.

    const attachBuyerSig = (psbtBytes: Uint8Array) => attachDummyBuyerSig(psbtBytes, publicKey);
    const buyerReceive = p2wpkhTestnet.address!;
    const otherAddr = btc.p2tr(publicKey.slice(1, 33), undefined, btc.TEST_NETWORK).address!;

    describe('expectedBuyerReceiveAddress (Output 0 address gate)', () => {

      it('accepts when Output 0 pays the expected buyer receive address', () => {
        const args = makeBaseArgs({
          destinations: {
            buyerReceiveAddress: buyerReceive,
            sellerPaymentAddress: p2wpkhTestnet.address!,
            buyerChangeAddress: p2wpkhTestnet.address!,
          },
        });
        const built = buildCat21BuyOfferPsbt(args);
        const result = validateCat21BuyOfferPsbt({
          psbt: attachBuyerSig(built.psbt),
          expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
          floorPriceSats: 21_000,
          expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
          expectedBuyerReceiveAddress: toOrdinalsAddress(buyerReceive),
          network: Network.Testnet3,
        });
        expect(result.ok).toBe(true);
      });

      it('rejects cat-output-wrong-address when Output 0 pays a different address', () => {
        const args = makeBaseArgs({
          destinations: {
            buyerReceiveAddress: buyerReceive,
            sellerPaymentAddress: p2wpkhTestnet.address!,
            buyerChangeAddress: p2wpkhTestnet.address!,
          },
        });
        const built = buildCat21BuyOfferPsbt(args);
        const result = validateCat21BuyOfferPsbt({
          psbt: attachBuyerSig(built.psbt),
          expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
          floorPriceSats: 21_000,
          expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
          expectedBuyerReceiveAddress: toOrdinalsAddress(otherAddr),
          network: Network.Testnet3,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('cat-output-wrong-address');
          expect(result.detail).toContain(otherAddr);
          expect(result.detail).toContain(buyerReceive);
        }
      });

      it('pass-through: when omitted, cat output address is not checked', () => {
        const args = makeBaseArgs();
        const built = buildCat21BuyOfferPsbt(args);
        const result = validateCat21BuyOfferPsbt({
          psbt: attachBuyerSig(built.psbt),
          expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
          floorPriceSats: 21_000,
          expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
          network: Network.Testnet3,
          // expectedBuyerReceiveAddress deliberately absent
        });
        expect(result.ok).toBe(true);
      });
    });

    describe('expectedBuyerChangeAddress (Output 2 address gate)', () => {

      it('accepts when Output 2 pays the expected buyer change address', () => {
        const args = makeBaseArgs({
          destinations: {
            buyerReceiveAddress: p2wpkhTestnet.address!,
            sellerPaymentAddress: p2wpkhTestnet.address!,
            buyerChangeAddress: buyerReceive,
          },
        });
        const built = buildCat21BuyOfferPsbt(args);
        // Base args yield 27_454 change → Output 2 is emitted.
        const result = validateCat21BuyOfferPsbt({
          psbt: attachBuyerSig(built.psbt),
          expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
          floorPriceSats: 21_000,
          expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
          expectedBuyerChangeAddress: toPaymentAddress(buyerReceive),
          network: Network.Testnet3,
        });
        expect(result.ok).toBe(true);
      });

      it('rejects change-output-wrong-address when Output 2 pays a different address', () => {
        const args = makeBaseArgs({
          destinations: {
            buyerReceiveAddress: p2wpkhTestnet.address!,
            sellerPaymentAddress: p2wpkhTestnet.address!,
            buyerChangeAddress: buyerReceive,
          },
        });
        const built = buildCat21BuyOfferPsbt(args);
        const result = validateCat21BuyOfferPsbt({
          psbt: attachBuyerSig(built.psbt),
          expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
          floorPriceSats: 21_000,
          expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
          expectedBuyerChangeAddress: toPaymentAddress(otherAddr),
          network: Network.Testnet3,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('change-output-wrong-address');
      });

      it('silent pass when the PSBT has no Output 2 (buyer had no change)', () => {
        // Under-fund the buyer so change is sub-dust and absorbed → 2 outputs only.
        const args = makeBaseArgs({
          destinations: {
            buyerReceiveAddress: p2wpkhTestnet.address!,
            sellerPaymentAddress: p2wpkhTestnet.address!,
            buyerChangeAddress: buyerReceive,
          },
          buyerInputs: [
            {
              txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
              vout: 1,
              value: 22_646, // 100 change → sub-dust → absorbed
              scriptPubKey: p2wpkhTestnet.script,
            },
          ],
        });
        const built = buildCat21BuyOfferPsbt(args);
        expect(btc.Transaction.fromPSBT(built.psbt).outputsLength).toBe(2);
        const result = validateCat21BuyOfferPsbt({
          psbt: attachBuyerSig(built.psbt),
          expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
          floorPriceSats: 21_000,
          expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
          expectedBuyerChangeAddress: toPaymentAddress(otherAddr),
          network: Network.Testnet3,
        });
        expect(result.ok).toBe(true);
      });

      it('pass-through: when omitted, change output address is not checked', () => {
        const args = makeBaseArgs();
        const built = buildCat21BuyOfferPsbt(args);
        const result = validateCat21BuyOfferPsbt({
          psbt: attachBuyerSig(built.psbt),
          expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
          floorPriceSats: 21_000,
          expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
          network: Network.Testnet3,
        });
        expect(result.ok).toBe(true);
      });
    });

    describe('expectedExactPrice (tightens floor to equality)', () => {

      it('accepts when pricePaidSats exactly equals expectedExactPrice', () => {
        const args = makeBaseArgs({ priceSats: 21_000 });
        const built = buildCat21BuyOfferPsbt(args);
        const result = validateCat21BuyOfferPsbt({
          psbt: attachBuyerSig(built.psbt),
          expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
          floorPriceSats: 0,
          expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
          expectedExactPrice: 21_000,
          network: Network.Testnet3,
        });
        expect(result.ok).toBe(true);
      });

      it('rejects wrong-price-exact when pricePaidSats differs by even 1 sat', () => {
        const args = makeBaseArgs({ priceSats: 21_000 });
        const built = buildCat21BuyOfferPsbt(args);
        const result = validateCat21BuyOfferPsbt({
          psbt: attachBuyerSig(built.psbt),
          expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
          floorPriceSats: 0,
          expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
          expectedExactPrice: 21_001,
          network: Network.Testnet3,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('wrong-price-exact');
          expect(result.detail).toContain('21000');
          expect(result.detail).toContain('21001');
        }
      });

      it('floor check still fires first (wrong-price beats wrong-price-exact when floor is violated)', () => {
        const args = makeBaseArgs({ priceSats: 21_000 });
        const built = buildCat21BuyOfferPsbt(args);
        // floorPriceSats=25_000 → floor check trips before exact check.
        const result = validateCat21BuyOfferPsbt({
          psbt: attachBuyerSig(built.psbt),
          expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
          floorPriceSats: 25_000,
          expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
          expectedExactPrice: 21_000,
          network: Network.Testnet3,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('wrong-price');
      });

      it('pass-through: when omitted, only the floor gate applies', () => {
        const args = makeBaseArgs({ priceSats: 21_000 });
        const built = buildCat21BuyOfferPsbt(args);
        const result = validateCat21BuyOfferPsbt({
          psbt: attachBuyerSig(built.psbt),
          expectedSellerUtxo: { txid: args.sellerInput.txid, vout: args.sellerInput.vout },
          floorPriceSats: 21_000,
          expectedSellerPaymentAddress: toPaymentAddress(p2wpkhTestnet.address!),
          network: Network.Testnet3,
          // expectedExactPrice deliberately absent → floor semantics stand
        });
        expect(result.ok).toBe(true);
      });
    });
  });
});
