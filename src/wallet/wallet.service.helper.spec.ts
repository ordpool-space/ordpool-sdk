import { describe, expect, it } from '@jest/globals';
import { AddressPurpose } from 'sats-connect';

import {
  detectInstalledWallets,
  isLeatherInstalled,
  isUnisatInstalled,
  isXverseInstalled,
  leatherOrdinalsAddressType,
  leatherPaymentAddressType,
  parseLeatherAddressResponse,
  parseXverseAddressResponse,
  unisatBasicInfoToWalletInfo,
} from './wallet.service.helper';
import {
  KnownOrdinalWallets,
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


describe('detectInstalledWallets', () => {

  it('returns all three as not-installed when window is undefined', () => {
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(undefined);
    expect(installedWallets).toEqual([]);
    expect(notInstalledWallets).toEqual([
      KnownOrdinalWallets.xverse,
      KnownOrdinalWallets.leather,
      KnownOrdinalWallets.unisat,
    ]);
  });

  it('returns all three as installed when every extension is present', () => {
    const win = { XverseProviders: {}, HiroWalletProvider: {}, unisat: {} };
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(win);
    expect(installedWallets).toEqual([
      KnownOrdinalWallets.xverse,
      KnownOrdinalWallets.leather,
      KnownOrdinalWallets.unisat,
    ]);
    expect(notInstalledWallets).toEqual([]);
  });

  it('partitions correctly when only some are installed', () => {
    const win = { XverseProviders: {}, unisat: {} }; // Leather missing
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(win);
    expect(installedWallets).toEqual([KnownOrdinalWallets.xverse, KnownOrdinalWallets.unisat]);
    expect(notInstalledWallets).toEqual([KnownOrdinalWallets.leather]);
  });

  it('keeps a stable detection order (Xverse, Leather, Unisat)', () => {
    const { installedWallets } = detectInstalledWallets({ unisat: {}, HiroWalletProvider: {}, XverseProviders: {} });
    expect(installedWallets.map(w => w.label)).toEqual([
      KnownOrdinalWallets.xverse.label,
      KnownOrdinalWallets.leather.label,
      KnownOrdinalWallets.unisat.label,
    ]);
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
