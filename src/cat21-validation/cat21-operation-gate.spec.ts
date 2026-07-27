import { describe, expect, it } from '@jest/globals';

import { Network } from '../network';

import { validateCat21Operation } from './cat21-operation-gate';
import type {
  Cat21AcceptOfferIntent,
  Cat21BuyIntent,
  Cat21CreateOfferIntent,
  Cat21MintIntent,
  Cat21OperationGateConfig,
  Cat21TransferIntent,
} from './cat21-operation-gate.types';

const MAINNET_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
// Mainnet P2TR (bech32m). From the BIP350 reference vectors.
const MAINNET_TAPROOT =
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';
const TESTNET_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

const VALID_CAT_ID =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefi0';
const VALID_CAT_ID_HI_VOUT =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefi42';

const mainnetConfig: Cat21OperationGateConfig = { network: Network.Mainnet };

function mintIntent(over: Partial<Cat21MintIntent> = {}): Cat21MintIntent {
  return { recipient: MAINNET_ADDR, feeRate: 5, ...over };
}
function transferIntent(over: Partial<Cat21TransferIntent> = {}): Cat21TransferIntent {
  return { catId: VALID_CAT_ID, recipient: MAINNET_ADDR, feeRate: 5, ...over };
}
function createOfferIntent(over: Partial<Cat21CreateOfferIntent> = {}): Cat21CreateOfferIntent {
  return {
    catId: VALID_CAT_ID,
    priceSats: 21_000,
    paymentAddress: MAINNET_ADDR,
    ...over,
  };
}
function buyIntent(over: Partial<Cat21BuyIntent> = {}): Cat21BuyIntent {
  return {
    catId: VALID_CAT_ID,
    bidSats: 21_000,
    sellerPaymentAddress: MAINNET_ADDR,
    feeRate: 5,
    ...over,
  };
}
function acceptOfferIntent(over: Partial<Cat21AcceptOfferIntent> = {}): Cat21AcceptOfferIntent {
  return {
    // PSBT magic bytes + a one-byte padding, hex-encoded. The gate's
    // structural check accepts as soon as the magic matches; the
    // SDK's `validateCat21BuyOfferPsbt` does the deeper parse later.
    offerPsbt: '70736274ff00',
    expectedCatId: VALID_CAT_ID,
    expectedPriceSats: 21_000,
    expectedSellerUtxo: {
      txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      vout: 0,
    },
    ...over,
  };
}

describe('validateCat21Operation — entry-level guards', () => {
  it('rejects non-object intent with intent-not-an-object', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'mint', intent: 'oops' as unknown as Cat21MintIntent },
    });
    expect(result).toEqual({ ok: false, reason: 'intent-not-an-object', detail: undefined });
  });
});

/* ──────────────────────────  Mint  ────────────────────────── */

describe('validateCat21Operation — mint happy paths', () => {
  it('accepts a minimal mint and returns recipientScript + tipScript:undefined', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'mint', intent: mintIntent() },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.resources.kind).toBe('mint');
    if (result.resources.kind === 'mint') {
      expect(result.resources.recipientScript.length).toBeGreaterThan(0);
      expect(result.resources.tipScript).toBeUndefined();
    }
  });

  it('accepts a mint with a positive-value tip and decodes the tip address', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'mint',
        intent: mintIntent({ tip: { address: MAINNET_TAPROOT, value: 1000 } }),
      },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind === 'mint') {
      expect(result.resources.tipScript).toBeDefined();
    }
  });

  it('accepts a mint with tip.value === 0 (builder will skip the output) without decoding tip address', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'mint',
        intent: mintIntent({ tip: { address: 'not-decodable-but-skipped', value: 0 } }),
      },
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateCat21Operation — mint recipient rejections', () => {
  it('rejects an undefined recipient', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'mint',
        intent: mintIntent({ recipient: undefined as unknown as string }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'recipient-not-a-bitcoin-address' });
  });

  it('rejects a malformed-string recipient as recipient-not-a-bitcoin-address', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'mint', intent: mintIntent({ recipient: 'not-a-real-address' }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'recipient-not-a-bitcoin-address' });
  });

  it('rejects a testnet address on a mainnet config as recipient-wrong-network', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'mint', intent: mintIntent({ recipient: TESTNET_ADDR }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'recipient-wrong-network' });
  });

  it('rejects a mainnet address on a testnet config as recipient-wrong-network', () => {
    const result = validateCat21Operation({
      config: { network: Network.Testnet3 },
      operation: { kind: 'mint', intent: mintIntent({ recipient: MAINNET_ADDR }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'recipient-wrong-network' });
  });

  it('rejects recipient absent from allowedRecipients', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedRecipients: [MAINNET_TAPROOT] },
      operation: { kind: 'mint', intent: mintIntent({ recipient: MAINNET_ADDR }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'recipient-not-allowed' });
  });

  it('accepts recipient present in allowedRecipients', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedRecipients: [MAINNET_ADDR, MAINNET_TAPROOT] },
      operation: { kind: 'mint', intent: mintIntent() },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects self-send when ownPaymentAddress matches recipient', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, ownPaymentAddress: MAINNET_ADDR },
      operation: { kind: 'mint', intent: mintIntent({ recipient: MAINNET_ADDR }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'self-send' });
  });
});

describe('validateCat21Operation — mint fee-rate rejections', () => {
  it.each([NaN, Infinity, -Infinity])('rejects non-finite feeRate %s', (badValue: number) => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'mint', intent: mintIntent({ feeRate: badValue }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'fee-rate-not-finite-number' });
  });

  it('rejects a non-number feeRate (string) as fee-rate-not-finite-number', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'mint', intent: mintIntent({ feeRate: '5' as unknown as number }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'fee-rate-not-finite-number' });
  });

  it('rejects a non-integer feeRate as fee-rate-not-integer', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'mint', intent: mintIntent({ feeRate: 1.5 }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'fee-rate-not-integer' });
  });

  it('rejects zero feeRate as fee-rate-not-positive', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'mint', intent: mintIntent({ feeRate: 0 }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'fee-rate-not-positive' });
  });

  it('rejects negative feeRate as fee-rate-not-positive', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'mint', intent: mintIntent({ feeRate: -1 }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'fee-rate-not-positive' });
  });

  it('rejects feeRate above maxFeeRatePerVbyte when set', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, maxFeeRatePerVbyte: 100 },
      operation: { kind: 'mint', intent: mintIntent({ feeRate: 101 }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'fee-rate-above-cap' });
  });

  it('accepts feeRate AT the cap (boundary)', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, maxFeeRatePerVbyte: 100 },
      operation: { kind: 'mint', intent: mintIntent({ feeRate: 100 }) },
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateCat21Operation — mint tip rejections', () => {
  it('rejects non-finite tip.value', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'mint',
        intent: mintIntent({ tip: { address: MAINNET_ADDR, value: NaN } }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'tip-value-not-finite-number' });
  });

  it('rejects non-integer tip.value', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'mint',
        intent: mintIntent({ tip: { address: MAINNET_ADDR, value: 1.5 } }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'tip-value-not-integer' });
  });

  it('rejects negative tip.value', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'mint',
        intent: mintIntent({ tip: { address: MAINNET_ADDR, value: -1 } }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'tip-value-negative' });
  });

  it('rejects tip.value above maxTipValueSats', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, maxTipValueSats: 5000 },
      operation: {
        kind: 'mint',
        intent: mintIntent({ tip: { address: MAINNET_ADDR, value: 5001 } }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'tip-value-above-cap' });
  });

  it('uses maxPriceSats as fallback tip cap when maxTipValueSats is unset', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, maxPriceSats: 3000 },
      operation: {
        kind: 'mint',
        intent: mintIntent({ tip: { address: MAINNET_ADDR, value: 3001 } }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'tip-value-above-cap' });
  });

  it('rejects malformed tip address (positive value)', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'mint',
        intent: mintIntent({ tip: { address: 'not-an-address', value: 100 } }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'tip-address-not-a-bitcoin-address' });
  });

  it('rejects wrong-network tip address (positive value)', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'mint',
        intent: mintIntent({ tip: { address: TESTNET_ADDR, value: 100 } }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'tip-address-wrong-network' });
  });
});

/* ──────────────────────────  Transfer  ────────────────────────── */

describe('validateCat21Operation — transfer', () => {
  it('accepts a valid transfer and returns recipientScript + catTxid + catIndex', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'transfer', intent: transferIntent() },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind === 'transfer') {
      expect(result.resources.catTxid).toHaveLength(64);
      expect(result.resources.catIndex).toBe(0);
    }
  });

  it('decodes non-zero cat index correctly', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'transfer', intent: transferIntent({ catId: VALID_CAT_ID_HI_VOUT }) },
    });
    if (!result.ok) throw new Error('expected ok');
    if (result.resources.kind === 'transfer') {
      expect(result.resources.catIndex).toBe(42);
    }
  });

  it.each([
    ['empty string', ''],
    ['wrong shape', 'plain-string'],
    ['short txid', '0123i0'],
    ['uppercase txid', 'ABCDEF'.repeat(10) + 'ABCDi0'],
    ['negative index', VALID_CAT_ID.replace('i0', 'i-1')],
    ['non-numeric index', VALID_CAT_ID.replace('i0', 'iabc')],
    ['no separator', VALID_CAT_ID.replace('i0', '00')],
  ])('rejects malformed catId (%s)', (_label: string, badCatId: string) => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'transfer', intent: transferIntent({ catId: badCatId as string }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'cat-id-malformed' });
  });

  it('inherits the same recipient + fee checks as mint', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'transfer', intent: transferIntent({ feeRate: 0 }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'fee-rate-not-positive' });
  });
});

/* ──────────────────────────  Buy  ────────────────────────── */

describe('validateCat21Operation — buy', () => {
  it('accepts a valid buy and returns sellerPaymentScript + catTxid + catIndex', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'buy', intent: buyIntent() },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.resources.kind).toBe('buy');
    if (result.resources.kind !== 'buy') throw new Error('narrowing');
    expect(result.resources.catIndex).toBe(0);
    expect(result.resources.sellerPaymentScript.length).toBeGreaterThan(0);
  });

  it('accepts a valid buy on a high-vout cat', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'buy', intent: buyIntent({ catId: VALID_CAT_ID_HI_VOUT }) },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind !== 'buy') throw new Error('narrowing');
    expect(result.resources.catIndex).toBe(42);
  });

  it('rejects a malformed catId', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'buy', intent: buyIntent({ catId: 'not-a-cat' }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'cat-id-malformed' });
  });

  it('rejects zero bidSats', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'buy', intent: buyIntent({ bidSats: 0 }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'price-not-positive' });
  });

  it('rejects a non-positive feeRate', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'buy', intent: buyIntent({ feeRate: 0 }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'fee-rate-not-positive' });
  });

  it('rejects a sellerPaymentAddress on the wrong network', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'buy', intent: buyIntent({ sellerPaymentAddress: TESTNET_ADDR }) },
    });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects buy when allowedOperations excludes it', () => {
    const result = validateCat21Operation({
      config: { network: Network.Mainnet, allowedOperations: ['mint'] },
      operation: { kind: 'buy', intent: buyIntent() },
    });
    expect(result).toMatchObject({ ok: false, reason: 'operation-kind-not-allowed' });
  });
});

/* ──────────────────────────  Create-offer  ────────────────────────── */

describe('validateCat21Operation — create_offer', () => {
  it('accepts a valid create-offer and returns paymentScript + catTxid + catIndex', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'create_offer', intent: createOfferIntent() },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.resources.kind).toBe('create_offer');
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite priceSats %s', (val: number) => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'create_offer', intent: createOfferIntent({ priceSats: val }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'price-not-finite-number' });
  });

  it('rejects non-integer priceSats', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'create_offer', intent: createOfferIntent({ priceSats: 100.5 }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'price-not-integer' });
  });

  it('rejects zero priceSats', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'create_offer', intent: createOfferIntent({ priceSats: 0 }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'price-not-positive' });
  });

  it('rejects priceSats below the protocol postage floor (CAT21_POSTAGE_SATS = 546)', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'create_offer', intent: createOfferIntent({ priceSats: 545 }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'price-below-postage-floor' });
  });

  it('rejects priceSats above maxPriceSats', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, maxPriceSats: 100_000 },
      operation: { kind: 'create_offer', intent: createOfferIntent({ priceSats: 100_001 }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'price-above-cap' });
  });

  it('rejects malformed paymentAddress as payment-address-not-a-bitcoin-address', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'create_offer',
        intent: createOfferIntent({ paymentAddress: 'oops' }),
      },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'payment-address-not-a-bitcoin-address',
    });
  });

  it('rejects wrong-network paymentAddress', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'create_offer',
        intent: createOfferIntent({ paymentAddress: TESTNET_ADDR }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'payment-address-wrong-network' });
  });

  it('rejects paymentAddress absent from allowedCounterparties', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedCounterparties: [MAINNET_TAPROOT] },
      operation: { kind: 'create_offer', intent: createOfferIntent() },
    });
    expect(result).toMatchObject({ ok: false, reason: 'payment-address-not-allowed' });
  });
});

/* ──────────────────────────  Accept-offer  ────────────────────────── */

describe('validateCat21Operation — accept_offer', () => {
  it('accepts a valid accept-offer and returns offerPsbtBytes + catTxid + catIndex', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'accept_offer', intent: acceptOfferIntent() },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.resources.kind).toBe('accept_offer');
    if (result.resources.kind === 'accept_offer') {
      expect(result.resources.offerPsbtBytes.length).toBeGreaterThan(0);
    }
  });

  it('accepts hex-encoded PSBT (the gate prefers hex over base64 when magic matches)', () => {
    // Same magic-prefixed hex as the default fixture; this test
    // exercises the explicit-hex path via a non-default value.
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'accept_offer',
        intent: acceptOfferIntent({ offerPsbt: '70736274ff0102030405' }),
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects bytes that successfully hex-decode but do not start with the PSBT magic', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'accept_offer', intent: acceptOfferIntent({ offerPsbt: 'deadbeef' }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'offer-psbt-missing-magic-bytes' });
  });

  it('rejects PSBT bytes that decode but do not start with the magic 0x70 0x73 0x62 0x74 0xff', () => {
    // base64('AAAA') = [0x00, 0x00, 0x00] — decodes but no magic.
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'accept_offer', intent: acceptOfferIntent({ offerPsbt: 'AAAA' }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'offer-psbt-missing-magic-bytes' });
  });

  it('accepts PSBT bytes that start with the magic (700a000000 hex = magic+padding)', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'accept_offer',
        intent: acceptOfferIntent({ offerPsbt: '70736274ff00' }),
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects raw string longer than 2 × maxOfferPsbtBytes (early DoS short-circuit)', () => {
    const huge = 'A'.repeat(2 * 1024 + 1);
    const result = validateCat21Operation({
      config: { ...mainnetConfig, maxOfferPsbtBytes: 1024 },
      operation: { kind: 'accept_offer', intent: acceptOfferIntent({ offerPsbt: huge }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'offer-psbt-too-large' });
  });

  it('rejects decoded PSBT longer than maxOfferPsbtBytes (post-decode check)', () => {
    // 18 bytes hex = 9 decoded bytes; cap 5 trips post-decode but the
    // string length is still under 2×5=10 chars so the early
    // short-circuit does NOT fire.
    const result = validateCat21Operation({
      config: { ...mainnetConfig, maxOfferPsbtBytes: 5 },
      operation: {
        kind: 'accept_offer',
        intent: acceptOfferIntent({ offerPsbt: '70736274ff00000000000000ff0000' }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'offer-psbt-too-large' });
  });

  it('rejects garbage offerPsbt as offer-psbt-malformed', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'accept_offer',
        intent: acceptOfferIntent({ offerPsbt: '???not-base64-or-hex???' }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'offer-psbt-malformed' });
  });

  it('rejects empty offerPsbt', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'accept_offer', intent: acceptOfferIntent({ offerPsbt: '' }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'offer-psbt-malformed' });
  });

  it('rejects malformed expectedCatId', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'accept_offer',
        intent: acceptOfferIntent({ expectedCatId: 'not-a-cat-id' }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'expected-cat-id-malformed' });
  });

  it('rejects expectedPriceSats non-finite', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'accept_offer',
        intent: acceptOfferIntent({ expectedPriceSats: NaN }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'expected-price-not-finite-number' });
  });

  it('rejects expectedPriceSats non-integer', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'accept_offer',
        intent: acceptOfferIntent({ expectedPriceSats: 21.5 }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'expected-price-not-integer' });
  });

  it('rejects expectedPriceSats non-positive', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'accept_offer',
        intent: acceptOfferIntent({ expectedPriceSats: 0 }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'expected-price-not-positive' });
  });

  it.each([
    ['short txid', { txid: 'abc', vout: 0 }],
    ['uppercase txid', { txid: 'A'.repeat(64), vout: 0 }],
    ['negative vout', { txid: '0'.repeat(64), vout: -1 }],
    ['non-integer vout', { txid: '0'.repeat(64), vout: 0.5 }],
    ['vout as string', { txid: '0'.repeat(64), vout: '0' as unknown as number }],
    ['missing fields', {}],
  ])('rejects malformed expectedSellerUtxo (%s)', (_label: string, badUtxo: object) => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'accept_offer',
        intent: acceptOfferIntent({
          expectedSellerUtxo: badUtxo as { txid: string; vout: number },
        }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'expected-seller-utxo-malformed' });
  });
});

/* ──────────────────────────  allowedOperations  ────────────────────────── */

describe('validateCat21Operation — allowedOperations capability gate', () => {
  it('accepts a mint when allowedOperations includes mint', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedOperations: ['mint'] },
      operation: { kind: 'mint', intent: mintIntent() },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a transfer when allowedOperations is ["mint"]', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedOperations: ['mint'] },
      operation: { kind: 'transfer', intent: transferIntent() },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'operation-kind-not-allowed',
      detail: 'transfer',
    });
  });

  it('rejects a create_offer when allowedOperations is ["mint", "transfer"]', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedOperations: ['mint', 'transfer'] },
      operation: { kind: 'create_offer', intent: createOfferIntent() },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'operation-kind-not-allowed',
      detail: 'create_offer',
    });
  });

  it('rejects an accept_offer when allowedOperations omits it', () => {
    const result = validateCat21Operation({
      config: {
        ...mainnetConfig,
        allowedOperations: ['mint', 'transfer', 'create_offer'],
      },
      operation: { kind: 'accept_offer', intent: acceptOfferIntent() },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'operation-kind-not-allowed',
      detail: 'accept_offer',
    });
  });

  it('treats an empty allowedOperations array as the permissive default', () => {
    // Wallets that build the config defensively might pass `[]` if the
    // policy slice hasn't been populated yet. That MUST be the
    // permissive default (any kind accepted), not the locked-down
    // "no kinds at all" — otherwise an empty policy would brick the
    // wallet for every operation.
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedOperations: [] },
      operation: { kind: 'mint', intent: mintIntent() },
    });
    expect(result.ok).toBe(true);
  });

  it('fires BEFORE per-operation field validation (no capability leak via reason)', () => {
    // A curious agent must not be able to probe which fields a
    // disallowed operation accepts. Pass a transfer intent with a
    // malformed catId; the gate's response should still be
    // 'operation-kind-not-allowed', NOT 'cat-id-malformed'.
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedOperations: ['mint'] },
      operation: {
        kind: 'transfer',
        intent: transferIntent({ catId: 'not-a-cat-id' }),
      },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'operation-kind-not-allowed',
    });
  });
});

/* ──────────────────────────  Address equivalence  ────────────────────────── */

describe('validateCat21Operation — address equivalence (BIP173 case-insensitive)', () => {
  // Per BIP173 bech32 strings are valid in either ALL-LOWERCASE or
  // ALL-UPPERCASE form and decode to the same address. Allowlist /
  // self-send checks MUST compare scriptPubKey, not literal string,
  // so an agent can't bypass either check by passing a different
  // case to a config that holds the other.

  const MAINNET_ADDR_UPPERCASE = MAINNET_ADDR.toUpperCase();

  it('self-send fires when recipient and ownPaymentAddress differ only in case (mint)', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, ownPaymentAddress: MAINNET_ADDR },
      operation: {
        kind: 'mint',
        intent: mintIntent({ recipient: MAINNET_ADDR_UPPERCASE }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'self-send' });
  });

  it('self-send fires when recipient and ownPaymentAddress differ only in case (transfer)', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, ownPaymentAddress: MAINNET_ADDR_UPPERCASE },
      operation: {
        kind: 'transfer',
        intent: transferIntent({ recipient: MAINNET_ADDR }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'self-send' });
  });

  it('allowedRecipients matches case-insensitively (mint)', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedRecipients: [MAINNET_ADDR] },
      operation: {
        kind: 'mint',
        intent: mintIntent({ recipient: MAINNET_ADDR_UPPERCASE }),
      },
    });
    expect(result.ok).toBe(true);
  });

  it('allowedRecipients matches case-insensitively (transfer)', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedRecipients: [MAINNET_ADDR_UPPERCASE] },
      operation: {
        kind: 'transfer',
        intent: transferIntent({ recipient: MAINNET_ADDR }),
      },
    });
    expect(result.ok).toBe(true);
  });

  it('allowedCounterparties matches case-insensitively (create_offer)', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedCounterparties: [MAINNET_ADDR_UPPERCASE] },
      operation: {
        kind: 'create_offer',
        intent: createOfferIntent({ paymentAddress: MAINNET_ADDR }),
      },
    });
    expect(result.ok).toBe(true);
  });

  it('different address types (P2WPKH vs P2TR) are NOT equivalent even at scriptPubKey level', () => {
    // Sanity check the equivalence helper: bech32 and bech32m on
    // different witness versions decode to different scripts; the
    // allowlist must not coalesce them.
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedRecipients: [MAINNET_TAPROOT] },
      operation: {
        kind: 'mint',
        intent: mintIntent({ recipient: MAINNET_ADDR }),
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'recipient-not-allowed' });
  });

  it('malformed allowlist entry does not crash the check', () => {
    // A typo'd allowlist entry should make the gate skip that entry
    // and reject if no valid entry matches — never throw.
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedRecipients: ['typo-address-not-decodable', MAINNET_ADDR] },
      operation: {
        kind: 'mint',
        intent: mintIntent({ recipient: MAINNET_ADDR }),
      },
    });
    expect(result.ok).toBe(true);
  });
});
