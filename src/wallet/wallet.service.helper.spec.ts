import { describe, expect, it } from '@jest/globals';
import { bech32m } from '@scure/base';
import { AddressPurpose } from 'sats-connect';

import {
  isLeatherInstalled,
  isUnisatInstalled,
  isXverseInstalled,
  leatherOrdinalsAddressType,
  leatherPaymentAddressType,
  parseLeatherAddressResponse,
  parsePhantomAddressResponse,
  parseXverseAddressResponse,
  repairXverseRegtestTaproot,
  unisatBasicInfoToWalletInfo,
} from './wallet.service.helper';
import {
  KnownOrdinalWalletType,
  LeatherAddressResponse,
  LeatherBtcAddress,
  XverseAddressResponse,
} from './wallet.service.types';


describe('isXverseInstalled / isLeatherInstalled / isUnisatInstalled', () => {

  it('returns false when window is undefined (Node, SSR)', () => {
    expect(isXverseInstalled(undefined)).toBe(false);
    expect(isLeatherInstalled(undefined)).toBe(false);
    expect(isUnisatInstalled(undefined)).toBe(false);
  });

  it('returns false when no extensions are present', () => {
    const win = {};
    expect(isXverseInstalled(win)).toBe(false);
    expect(isLeatherInstalled(win)).toBe(false);
    expect(isUnisatInstalled(win)).toBe(false);
  });

  it('returns true when the matching extension shim is present', () => {
    expect(isXverseInstalled({ XverseProviders: {} })).toBe(true);
    expect(isLeatherInstalled({ HiroWalletProvider: {} })).toBe(true);
    expect(isUnisatInstalled({ unisat: {} })).toBe(true);
  });

  it('detects each extension independently', () => {
    const onlyXverse = { XverseProviders: {} };
    expect(isXverseInstalled(onlyXverse)).toBe(true);
    expect(isLeatherInstalled(onlyXverse)).toBe(false);
    expect(isUnisatInstalled(onlyXverse)).toBe(false);
  });
});


describe('parseXverseAddressResponse', () => {

  const makeResponse = (parts: Partial<{
    ordinalsAddress: string;
    ordinalsPublicKey: string;
    paymentAddress: string;
    paymentPublicKey: string;
  }>): XverseAddressResponse => {
    const addresses: XverseAddressResponse['addresses'] = [];
    if (parts.ordinalsAddress !== undefined) {
      addresses.push({
        address: parts.ordinalsAddress,
        publicKey: parts.ordinalsPublicKey ?? '',
        purpose: AddressPurpose.Ordinals,
      });
    }
    if (parts.paymentAddress !== undefined) {
      addresses.push({
        address: parts.paymentAddress,
        publicKey: parts.paymentPublicKey ?? '',
        purpose: AddressPurpose.Payment,
      });
    }
    return { addresses };
  };

  it('maps a complete Xverse response to WalletInfo', () => {
    const response = makeResponse({
      ordinalsAddress: 'bc1pordinals',
      ordinalsPublicKey: 'ord-pub',
      paymentAddress: '3payment',
      paymentPublicKey: 'pay-pub',
    });
    expect(parseXverseAddressResponse(response)).toEqual({
      type: KnownOrdinalWalletType.xverse,
      ordinalsAddress: 'bc1pordinals',
      ordinalsPublicKey: 'ord-pub',
      paymentAddress: '3payment',
      paymentPublicKey: 'pay-pub',
      signingSupported: true,
    });
  });

  it('throws when the ordinals address is missing', () => {
    const response = makeResponse({ paymentAddress: '3payment' });
    expect(() => parseXverseAddressResponse(response)).toThrow('Required address not found?!');
  });

  it('throws when the payment address is missing', () => {
    const response = makeResponse({ ordinalsAddress: 'bc1pordinals' });
    expect(() => parseXverseAddressResponse(response)).toThrow('Required address not found?!');
  });

  it('throws when both are missing', () => {
    expect(() => parseXverseAddressResponse({ addresses: [] })).toThrow('Required address not found?!');
  });
});


describe('repairXverseRegtestTaproot', () => {

  it('passes through mainnet taproot addresses unchanged', () => {
    const mainnet = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
    expect(repairXverseRegtestTaproot(mainnet)).toBe(mainnet);
  });

  it('passes through testnet taproot addresses unchanged', () => {
    const testnet = 'tb1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqp3mvzv';
    expect(repairXverseRegtestTaproot(testnet)).toBe(testnet);
  });

  it('passes through a valid bcrt1p… taproot address unchanged', () => {
    // Compute a valid regtest taproot by re-encoding the tb variant with bcrt HRP.
    // (This is exactly the repair path, so this exercises the "no-op if already valid" branch.)
    const tbAddr = 'tb1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqp3mvzv';
    const valid = repairXverseRegtestTaproot(tbAddr.replace(/^tb/, 'bcrt'));
    expect(repairXverseRegtestTaproot(valid)).toBe(valid);
  });

  it('repairs Xverse\'s broken bcrt1p… address (tb-computed checksum) to a valid bech32m bcrt address', () => {
    // From CI diagnostic 29045576493 — Xverse returned this address, both bech32
    // and bech32m rejected it, but replacing bcrt->tb round-tripped as bech32m.
    const broken = 'bcrt1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqp3mvzv';
    const repaired = repairXverseRegtestTaproot(broken);
    expect(repaired).not.toBe(broken);
    expect(repaired).toMatch(/^bcrt1p/);
    // Repaired address decodes as valid bech32m under bcrt HRP.
    expect(() => bech32m.decode(repaired as `${string}1${string}`)).not.toThrow();
    // Same words as the tb equivalent — repair is HRP-swap, not data change.
    const tbEquivalent = ('tb' + broken.slice(4)) as `${string}1${string}`;
    const tbWords = bech32m.decode(tbEquivalent).words;
    expect(bech32m.decode(repaired as `${string}1${string}`).words).toEqual(tbWords);
  });

  it('returns input unchanged if neither bcrt nor tb variant decodes (genuinely broken address)', () => {
    // Random 63-char bcrt1p prefix with no valid checksum under any HRP.
    const bogus = 'bcrt1p' + 'q'.repeat(58);
    expect(repairXverseRegtestTaproot(bogus)).toBe(bogus);
  });
});


describe('parseLeatherAddressResponse', () => {

  const makeResponse = (parts: Partial<{
    ordinalsAddress: string;
    ordinalsPublicKey: string;
    paymentAddress: string;
    paymentPublicKey: string;
  }>): LeatherAddressResponse => {
    const addresses: LeatherBtcAddress[] = [];
    if (parts.ordinalsAddress !== undefined) {
      addresses.push({
        address: parts.ordinalsAddress,
        publicKey: parts.ordinalsPublicKey ?? '',
        type: leatherOrdinalsAddressType,
        symbol: 'BTC',
        derivationPath: 'm/86h/0h/0h/0/0',
      });
    }
    if (parts.paymentAddress !== undefined) {
      addresses.push({
        address: parts.paymentAddress,
        publicKey: parts.paymentPublicKey ?? '',
        type: leatherPaymentAddressType,
        symbol: 'BTC',
        derivationPath: 'm/84h/0h/0h/0/0',
      });
    }
    return {
      jsonrpc: '2.0',
      id: 'test',
      result: { addresses },
    };
  };

  it('maps a complete Leather response to WalletInfo', () => {
    const response = makeResponse({
      ordinalsAddress: 'bc1pordinals',
      ordinalsPublicKey: 'ord-pub',
      paymentAddress: 'bc1qpayment',
      paymentPublicKey: 'pay-pub',
    });
    expect(parseLeatherAddressResponse(response)).toEqual({
      type: KnownOrdinalWalletType.leather,
      ordinalsAddress: 'bc1pordinals',
      ordinalsPublicKey: 'ord-pub',
      paymentAddress: 'bc1qpayment',
      paymentPublicKey: 'pay-pub',
      signingSupported: true,
    });
  });

  it('throws when the taproot (ordinals) address is missing', () => {
    const response = makeResponse({ paymentAddress: 'bc1qpayment' });
    expect(() => parseLeatherAddressResponse(response)).toThrow('Required address not found?!');
  });

  it('throws when the native segwit (payment) address is missing', () => {
    const response = makeResponse({ ordinalsAddress: 'bc1pordinals' });
    expect(() => parseLeatherAddressResponse(response)).toThrow('Required address not found?!');
  });

  it('throws when neither expected address type is present', () => {
    const response: LeatherAddressResponse = {
      jsonrpc: '2.0',
      id: 'test',
      result: { addresses: [] },
    };
    expect(() => parseLeatherAddressResponse(response)).toThrow('Required address not found?!');
  });

  it('normalises a compressed taproot ordinalsPublicKey (66 hex) to x-only (64 hex)', () => {
    // Leather v6.x's getAddresses returns the taproot pubkey in
    // compressed form (1 parity byte + 32 x-coord bytes). The
    // SDK contract on WalletInfo.ordinalsPublicKey is x-only —
    // strip the leading parity byte so consumers don't have to
    // re-derive depending on wallet vendor.
    const response = makeResponse({
      ordinalsAddress: 'bc1pordinals',
      ordinalsPublicKey: '03cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115',
      paymentAddress: 'bc1qpayment',
      paymentPublicKey: '0212345678901234567890123456789012345678901234567890123456789012ab',
    });
    const info = parseLeatherAddressResponse(response);
    // Parity byte (03) is stripped; the remaining 32 bytes are the x-only key.
    expect(info.ordinalsPublicKey).toBe('cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115');
    // paymentPublicKey is sec256k1-compressed by spec; passes through unchanged.
    expect(info.paymentPublicKey).toBe('0212345678901234567890123456789012345678901234567890123456789012ab');
  });

  it('passes an already-x-only taproot ordinalsPublicKey (64 hex) through unchanged', () => {
    const response = makeResponse({
      ordinalsAddress: 'bc1pordinals',
      ordinalsPublicKey: 'cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115',
      paymentAddress: 'bc1qpayment',
      paymentPublicKey: 'pay-pub',
    });
    expect(parseLeatherAddressResponse(response).ordinalsPublicKey).toBe(
      'cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115',
    );
  });
});


describe('parsePhantomAddressResponse', () => {

  it('splits Phantom\'s purpose-tagged array into payment vs ordinals lanes', () => {
    const info = parsePhantomAddressResponse([
      {
        address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
        publicKey: 'cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115',
        addressType: 'p2tr',
        purpose: 'ordinals',
      },
      {
        address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
        publicKey: '0212345678901234567890123456789012345678901234567890123456789012ab',
        addressType: 'p2wpkh',
        purpose: 'payment',
      },
    ]);
    expect(info.type).toBe(KnownOrdinalWalletType.phantom);
    expect(info.ordinalsAddress).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
    expect(info.paymentAddress).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(info.signingSupported).toBe(true);
  });

  it('normalises a compressed taproot ordinalsPublicKey to x-only (Phantom may return compressed like Leather does)', () => {
    const info = parsePhantomAddressResponse([
      {
        address: 'bc1pordinals',
        publicKey: '03cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115',
        addressType: 'p2tr',
        purpose: 'ordinals',
      },
      {
        address: 'bc1qpayment',
        publicKey: '02pay',
        addressType: 'p2wpkh',
        purpose: 'payment',
      },
    ]);
    expect(info.ordinalsPublicKey).toBe('cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115');
  });

  it('throws when the ordinals (purpose=ordinals) address is missing', () => {
    expect(() => parsePhantomAddressResponse([
      { address: 'bc1qpayment', publicKey: '02pay', addressType: 'p2wpkh', purpose: 'payment' },
    ])).toThrow('Required address not found?!');
  });

  it('throws when the payment (purpose=payment) address is missing', () => {
    expect(() => parsePhantomAddressResponse([
      { address: 'bc1pordinals', publicKey: 'ord', addressType: 'p2tr', purpose: 'ordinals' },
    ])).toThrow('Required address not found?!');
  });
});


describe('unisatBasicInfoToWalletInfo', () => {

  it('uses the same address for both payment and ordinals (Unisat single-address model)', () => {
    const result = unisatBasicInfoToWalletInfo('bc1qunisat', 'unisat-pub');
    expect(result).toEqual({
      type: KnownOrdinalWalletType.unisat,
      ordinalsAddress: 'bc1qunisat',
      ordinalsPublicKey: 'unisat-pub',
      paymentAddress: 'bc1qunisat',
      paymentPublicKey: 'unisat-pub',
      signingSupported: true,
    });
  });
});
