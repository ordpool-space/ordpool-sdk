import { describe, expect, it } from '@jest/globals';
import * as btc from '@scure/btc-signer';
import { BitcoinNetworkType } from 'sats-connect';

import { Network, toBitcoinNetworkType, toLeatherNetworkString, toScureNetwork } from './network';

describe('toScureNetwork', () => {

  it('maps Mainnet to btc.NETWORK', () => {
    expect(toScureNetwork(Network.Mainnet)).toBe(btc.NETWORK);
  });

  it('maps every testnet variant to btc.TEST_NETWORK', () => {
    expect(toScureNetwork(Network.Testnet3)).toBe(btc.TEST_NETWORK);
    expect(toScureNetwork(Network.Testnet4)).toBe(btc.TEST_NETWORK);
    expect(toScureNetwork(Network.Signet)).toBe(btc.TEST_NETWORK);
    expect(toScureNetwork(Network.Regtest)).toBe(btc.TEST_NETWORK);
  });
});

describe('toBitcoinNetworkType', () => {

  it('maps Mainnet to BitcoinNetworkType.Mainnet', () => {
    expect(toBitcoinNetworkType(Network.Mainnet)).toBe(BitcoinNetworkType.Mainnet);
  });

  it('maps every testnet variant to BitcoinNetworkType.Testnet', () => {
    expect(toBitcoinNetworkType(Network.Testnet3)).toBe(BitcoinNetworkType.Testnet);
    expect(toBitcoinNetworkType(Network.Testnet4)).toBe(BitcoinNetworkType.Testnet);
    expect(toBitcoinNetworkType(Network.Signet)).toBe(BitcoinNetworkType.Testnet);
    expect(toBitcoinNetworkType(Network.Regtest)).toBe(BitcoinNetworkType.Testnet);
  });
});

describe('toLeatherNetworkString', () => {

  it('maps Mainnet to "mainnet"', () => {
    expect(toLeatherNetworkString(Network.Mainnet)).toBe('mainnet');
  });

  it('maps Signet to "signet"', () => {
    expect(toLeatherNetworkString(Network.Signet)).toBe('signet');
  });

  it('maps Regtest to "devnet"', () => {
    expect(toLeatherNetworkString(Network.Regtest)).toBe('devnet');
  });

  it('maps Testnet3 and Testnet4 to "testnet"', () => {
    expect(toLeatherNetworkString(Network.Testnet3)).toBe('testnet');
    expect(toLeatherNetworkString(Network.Testnet4)).toBe('testnet');
  });
});
