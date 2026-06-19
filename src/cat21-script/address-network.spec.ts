import { describe, expect, it } from '@jest/globals';

import {
  getAddressNetwork,
  isAddressCompatibleWithNetwork,
} from './address-format';

describe('getAddressNetwork', () => {

  it.each([
    ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mainnet'],
    ['bc1ptest', 'mainnet'],
    ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'mainnet'],
    ['3FZbgi29cpjq2GjdwV8eyHuJJnkLtktZc5', 'mainnet'],
    ['bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7k0xnzj0', 'regtest'],
    ['bcrt1psomething', 'regtest'],
    ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'testnet'],
    ['tb1psomething', 'testnet'],
    ['mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef', 'testnet'],
    ['n1xxx', 'testnet'],
    ['2N1xxx', 'testnet'],
  ])('classifies %s as %s', (address, expected) => {
    expect(getAddressNetwork(address)).toBe(expected);
  });

  it('throws on unrecognised prefixes', () => {
    expect(() => getAddressNetwork('xpub...')).toThrow(/Unsupported/);
    expect(() => getAddressNetwork('')).toThrow(/Unsupported/);
  });
});

describe('isAddressCompatibleWithNetwork', () => {

  it('matches the obvious cases', () => {
    expect(isAddressCompatibleWithNetwork('bc1qabc', 'mainnet')).toBe(true);
    expect(isAddressCompatibleWithNetwork('bc1qabc', 'regtest')).toBe(false);
    expect(isAddressCompatibleWithNetwork('bc1qabc', 'testnet')).toBe(false);
    expect(isAddressCompatibleWithNetwork('bcrt1qabc', 'regtest')).toBe(true);
    expect(isAddressCompatibleWithNetwork('bcrt1qabc', 'mainnet')).toBe(false);
    expect(isAddressCompatibleWithNetwork('bcrt1qabc', 'testnet')).toBe(false);
    expect(isAddressCompatibleWithNetwork('tb1qabc', 'testnet')).toBe(true);
    expect(isAddressCompatibleWithNetwork('tb1qabc', 'mainnet')).toBe(false);
  });

  it('treats legacy `m` / `n` / `2` as compatible with both testnet AND regtest (shared key bytes)', () => {
    // Legacy testnet/regtest/signet share the same address key bytes
    // (0x6f for P2PKH, 0xc4 for P2SH). The address alone cannot
    // disambiguate, so the warning must be lenient here.
    expect(isAddressCompatibleWithNetwork('mzBc4XEF', 'testnet')).toBe(true);
    expect(isAddressCompatibleWithNetwork('mzBc4XEF', 'regtest')).toBe(true);
    expect(isAddressCompatibleWithNetwork('n1xxx', 'testnet')).toBe(true);
    expect(isAddressCompatibleWithNetwork('n1xxx', 'regtest')).toBe(true);
    expect(isAddressCompatibleWithNetwork('2N1xxx', 'testnet')).toBe(true);
    expect(isAddressCompatibleWithNetwork('2N1xxx', 'regtest')).toBe(true);
  });

  it('bech32 prefixes stay unambiguous — tb1/bcrt1 never cross-match', () => {
    // bech32 HRPs are distinct, so the warning is strict here.
    expect(isAddressCompatibleWithNetwork('tb1qabc', 'regtest')).toBe(false);
    expect(isAddressCompatibleWithNetwork('bcrt1qabc', 'testnet')).toBe(false);
  });
});
