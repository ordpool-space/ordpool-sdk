import { describe, expect, it } from '@jest/globals';
import * as btc from '@scure/btc-signer';
import { BitcoinNetworkType } from 'sats-connect';

import { Network, toBitcoinNetworkType, toLeatherNetworkString, toScureNetwork } from './network';

describe('toScureNetwork', () => {

  it('maps Mainnet to btc.NETWORK', () => {
    expect(toScureNetwork(Network.Mainnet)).toBe(btc.NETWORK);
  });

  it('maps Testnet3 / Testnet4 / Signet to btc.TEST_NETWORK (scure flattens them)', () => {
    expect(toScureNetwork(Network.Testnet3)).toBe(btc.TEST_NETWORK);
    expect(toScureNetwork(Network.Testnet4)).toBe(btc.TEST_NETWORK);
    expect(toScureNetwork(Network.Signet)).toBe(btc.TEST_NETWORK);
  });

  it('maps Regtest to a "bcrt"-prefixed network (testnet key params, regtest HRP)', () => {
    const regtest = toScureNetwork(Network.Regtest);
    expect(regtest.bech32).toBe('bcrt');
    expect(regtest.wif).toBe(btc.TEST_NETWORK.wif);
    expect(regtest.pubKeyHash).toBe(btc.TEST_NETWORK.pubKeyHash);
    expect(regtest.scriptHash).toBe(btc.TEST_NETWORK.scriptHash);
  });
});

describe('toBitcoinNetworkType', () => {

  it('maps Mainnet to BitcoinNetworkType.Mainnet', () => {
    expect(toBitcoinNetworkType(Network.Mainnet)).toBe(BitcoinNetworkType.Mainnet);
  });

  it('maps Testnet3 to BitcoinNetworkType.Testnet (legacy, Xverse no longer offers testnet3)', () => {
    expect(toBitcoinNetworkType(Network.Testnet3)).toBe(BitcoinNetworkType.Testnet);
  });

  it('maps Testnet4 / Signet / Regtest to their literal string values (cast through BitcoinNetworkType because sats-connect@1.1.2 enum is incomplete)', () => {
    // Xverse's runtime mismatch-check compares the request type to
    // the wallet's active chain `mode` — a Testnet4-mode wallet
    // only matches `type: "Testnet4"`, NOT `Testnet`. The
    // sats-connect@1.1.2 enum only declares Mainnet + Testnet, but
    // the strings ride through the postMessage bridge fine.
    expect(toBitcoinNetworkType(Network.Testnet4)).toBe('Testnet4');
    expect(toBitcoinNetworkType(Network.Signet)).toBe('Signet');
    expect(toBitcoinNetworkType(Network.Regtest)).toBe('Regtest');
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
