import { describe, expect, it } from '@jest/globals';

import {
  changeDustFloor,
  getAddressFormat,
  isInscribeSupportedPaymentAddress,
  isSegWit,
} from './address-format';

describe('changeDustFloor', () => {
  it('returns the per-address-type minimum for recognised prefixes', () => {
    expect(changeDustFloor('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(294); // P2WPKH
    expect(changeDustFloor('bc1p5cyxnuxmeuwuvkwfem96lqzszd9r3rqmxmzu4a')).toBe(330); // P2TR
    expect(changeDustFloor('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(546); // P2PKH
    expect(changeDustFloor('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(546); // P2SH
    expect(changeDustFloor('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')).toBe(294); // regtest P2WPKH
  });

  it('falls back to 546 for an unrecognised address (matches the builders’ catch)', () => {
    expect(changeDustFloor('not-an-address')).toBe(546);
  });
});

describe('isInscribeSupportedPaymentAddress', () => {

  it('accepts Native SegWit (P2WPKH)', () => {
    expect(isInscribeSupportedPaymentAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx')).toBe(true);
    expect(isInscribeSupportedPaymentAddress('tb1qz69ej270c3q9qvgt822t6pm3zdksk2x35j2jlm')).toBe(true);
    expect(isInscribeSupportedPaymentAddress('bcrt1qtest0000000000000000000000000000000000')).toBe(true);
  });

  it('accepts Taproot (P2TR)', () => {
    expect(isInscribeSupportedPaymentAddress('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9')).toBe(true);
    expect(isInscribeSupportedPaymentAddress('tb1p85ra9kv6a48yvk4mq4hx08wxk6t32tdjw9ylahergexkymsc3uwsdrx6sh')).toBe(true);
  });

  it('accepts P2SH (assumed to wrap SegWit; non-SegWit P2SH is rare and fails elsewhere)', () => {
    expect(isInscribeSupportedPaymentAddress('3E8ociqZa9mZUSwGdSmAEMAoAxBK3FNDcd')).toBe(true);
    expect(isInscribeSupportedPaymentAddress('2N1SP7r92ZZJvYKG2oNtzPwYnzw62up7mTo')).toBe(true);
  });

  it('REJECTS Legacy P2PKH (the postage-loss vector)', () => {
    // Mainnet 1-prefix
    expect(isInscribeSupportedPaymentAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(false);
    // Testnet m/n-prefix
    expect(isInscribeSupportedPaymentAddress('mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef')).toBe(false);
    expect(isInscribeSupportedPaymentAddress('n2eMqTT929pb1RDNuqEnxdaLau1rxy3efi')).toBe(false);
  });
});

// Regression coverage for the two helpers that the P2PKH guard
// composes over — sanity-pins the address-shape classification the
// inscribe guard depends on.
describe('isSegWit', () => {
  it('P2PKH is not SegWit', () => {
    expect(isSegWit('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(false);
  });
  it('P2WPKH, P2TR, P2SH all treated as SegWit-capable', () => {
    expect(isSegWit('bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx')).toBe(true);
    expect(isSegWit('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9')).toBe(true);
    expect(isSegWit('3E8ociqZa9mZUSwGdSmAEMAoAxBK3FNDcd')).toBe(true);
  });
});

describe('getAddressFormat', () => {
  it('returns the expected format per prefix', () => {
    expect(getAddressFormat('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe('P2PKH');
    expect(getAddressFormat('3E8ociqZa9mZUSwGdSmAEMAoAxBK3FNDcd')).toBe('P2SH???');
    expect(getAddressFormat('bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx')).toBe('P2WPKH');
    expect(getAddressFormat('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9')).toBe('P2TR');
  });
});
