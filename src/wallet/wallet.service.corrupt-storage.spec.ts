import { describe, expect, it } from '@jest/globals';

import { isValidPersistedWalletInfo } from './wallet.service';
import { KnownOrdinalWalletType } from './wallet.service.types';

describe('isValidPersistedWalletInfo — protects the WalletService constructor from wedging Angular DI', () => {

  const validPayload = {
    type: KnownOrdinalWalletType.xverse,
    ordinalsAddress: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9',
    paymentAddress: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx',
    paymentPublicKey: '02' + 'aa'.repeat(32),
    ordinalsPublicKey: '02' + 'bb'.repeat(32),
    signingSupported: true,
  };

  it('accepts a well-formed persisted WalletInfo', () => {
    expect(isValidPersistedWalletInfo(validPayload)).toBe(true);
  });

  it('accepts a payload with extra unknown fields (forward compat)', () => {
    expect(
      isValidPersistedWalletInfo({ ...validPayload, someFutureField: 'x', anotherOne: 42 }),
    ).toBe(true);
  });

  it('rejects null / undefined / primitives', () => {
    expect(isValidPersistedWalletInfo(null)).toBe(false);
    expect(isValidPersistedWalletInfo(undefined)).toBe(false);
    expect(isValidPersistedWalletInfo(42)).toBe(false);
    expect(isValidPersistedWalletInfo('bc1p…')).toBe(false);
    expect(isValidPersistedWalletInfo(true)).toBe(false);
    expect(isValidPersistedWalletInfo([])).toBe(false);
  });

  it('rejects a payload with an unknown wallet type (schema drift)', () => {
    // e.g. an older SDK stored `type: "old-name"` before the enum was
    // renamed. Constructor would try to armAccountChangeSubscription on
    // a type the connectors table doesn't know; downstream failure.
    expect(
      isValidPersistedWalletInfo({ ...validPayload, type: 'some-retired-wallet' }),
    ).toBe(false);
  });

  it('rejects a payload missing ordinalsAddress', () => {
    const { ordinalsAddress, ...missingOrd } = validPayload;
    void ordinalsAddress;
    expect(isValidPersistedWalletInfo(missingOrd)).toBe(false);
  });

  it('rejects a payload with empty-string ordinalsAddress', () => {
    expect(
      isValidPersistedWalletInfo({ ...validPayload, ordinalsAddress: '' }),
    ).toBe(false);
  });

  it('rejects a payload missing paymentAddress', () => {
    const { paymentAddress, ...missingPay } = validPayload;
    void paymentAddress;
    expect(isValidPersistedWalletInfo(missingPay)).toBe(false);
  });

  it('rejects a payload with non-string type', () => {
    expect(
      isValidPersistedWalletInfo({ ...validPayload, type: 42 as unknown as string }),
    ).toBe(false);
  });

  it('rejects a payload with non-string ordinalsAddress', () => {
    expect(
      isValidPersistedWalletInfo({ ...validPayload, ordinalsAddress: 42 as unknown as string }),
    ).toBe(false);
  });
});
