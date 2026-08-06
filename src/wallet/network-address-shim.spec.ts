import { describe, expect, it } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';

import { Network, toScureNetwork } from '../network';
import {
  toMainnetAddress,
  toRegtestAddress,
  toRegtestWalletInfo,
  toWireNetworkFor,
  walletSidePaymentAddress,
} from './network-address-shim';
import { KnownOrdinalWalletType, WalletInfo } from './wallet.service.types';

/**
 * The shim's whole point is: derived bcrt address encodes the SAME
 * scriptPubKey bytes as its mainnet twin (HRP and checksum change,
 * script bytes don't). We test the invariant directly instead of
 * pinning bcrt strings — those change if @scure/btc-signer ever bumps
 * its bech32m checksum implementation, but the invariant doesn't.
 *
 * The pubkey is arbitrary — any 33-byte compressed secp256k1 pubkey
 * works. We use a valid one from a fixed private key so the derived
 * addresses are deterministic and re-computable.
 */
const PRIVKEY = hex.decode('11'.repeat(32));
const PUBKEY = secp256k1.getPublicKey(PRIVKEY, true);
const PUBKEY_HEX = hex.encode(PUBKEY);

const MAINNET = btc.NETWORK;
const REGTEST = toScureNetwork(Network.Regtest);

function scriptBytesOf(address: string, network: typeof btc.NETWORK): string {
  return hex.encode(btc.OutScript.encode(btc.Address(network).decode(address)));
}

describe('toRegtestAddress', () => {
  it('bc1q P2WPKH → bcrt1q with identical script hash', () => {
    const mainnet = btc.p2wpkh(PUBKEY, MAINNET).address!;
    const regtest = toRegtestAddress(mainnet, PUBKEY_HEX);
    expect(regtest).toMatch(/^bcrt1q/);
    expect(scriptBytesOf(regtest, REGTEST)).toBe(scriptBytesOf(mainnet, MAINNET));
  });

  it('bc1p P2TR → bcrt1p with identical script hash (compressed pubkey trimmed to x-only)', () => {
    const xonly = PUBKEY.slice(1, 33);
    const mainnet = btc.p2tr(xonly, undefined, MAINNET).address!;
    const regtest = toRegtestAddress(mainnet, PUBKEY_HEX);
    expect(regtest).toMatch(/^bcrt1p/);
    expect(scriptBytesOf(regtest, REGTEST)).toBe(scriptBytesOf(mainnet, MAINNET));
  });

  it('3… P2SH-P2WPKH → bcrt-2… with identical script hash', () => {
    const mainnet = btc.p2sh(btc.p2wpkh(PUBKEY, MAINNET), MAINNET).address!;
    expect(mainnet).toMatch(/^3/);
    const regtest = toRegtestAddress(mainnet, PUBKEY_HEX);
    // Regtest P2SH addresses start with '2'.
    expect(regtest).toMatch(/^2/);
    expect(scriptBytesOf(regtest, REGTEST)).toBe(scriptBytesOf(mainnet, MAINNET));
  });

  it('1… P2PKH → m… P2PKH with identical script hash', () => {
    const mainnet = btc.p2pkh(PUBKEY, MAINNET).address!;
    expect(mainnet).toMatch(/^1/);
    const regtest = toRegtestAddress(mainnet, PUBKEY_HEX);
    // Regtest P2PKH addresses start with 'm' or 'n'.
    expect(regtest).toMatch(/^[mn]/);
    expect(scriptBytesOf(regtest, REGTEST)).toBe(scriptBytesOf(mainnet, MAINNET));
  });

  it('throws on an unsupported address prefix', () => {
    expect(() => toRegtestAddress('bogus_address', PUBKEY_HEX))
      .toThrow(/unsupported address type/i);
  });
});

describe('toRegtestWalletInfo', () => {
  it('translates both payment (bc1q) and ordinals (bc1p) slots to their bcrt equivalents', () => {
    const paymentMainnet = btc.p2wpkh(PUBKEY, MAINNET).address!;
    const ordinalsMainnet = btc.p2tr(PUBKEY.slice(1, 33), undefined, MAINNET).address!;

    const mainnetInfo: WalletInfo = {
      type: KnownOrdinalWalletType.leather,
      paymentAddress:    paymentMainnet,
      paymentPublicKey:  PUBKEY_HEX,
      ordinalsAddress:   ordinalsMainnet,
      ordinalsPublicKey: PUBKEY_HEX,
      signingSupported:  true,
    };

    const regtestInfo = toRegtestWalletInfo(mainnetInfo);

    expect(regtestInfo.paymentAddress).toMatch(/^bcrt1q/);
    expect(regtestInfo.ordinalsAddress).toMatch(/^bcrt1p/);
    expect(scriptBytesOf(regtestInfo.paymentAddress,  REGTEST))
      .toBe(scriptBytesOf(paymentMainnet, MAINNET));
    expect(scriptBytesOf(regtestInfo.ordinalsAddress, REGTEST))
      .toBe(scriptBytesOf(ordinalsMainnet, MAINNET));

    // Everything else preserved unchanged.
    expect(regtestInfo.paymentPublicKey).toBe(mainnetInfo.paymentPublicKey);
    expect(regtestInfo.ordinalsPublicKey).toBe(mainnetInfo.ordinalsPublicKey);
    expect(regtestInfo.type).toBe(KnownOrdinalWalletType.leather);
    expect(regtestInfo.signingSupported).toBe(true);
  });
});

describe('toMainnetAddress', () => {
  it('bcrt1q → bc1q with identical script hash (inverse of toRegtestAddress)', () => {
    const bcrt = btc.p2wpkh(PUBKEY, REGTEST).address!;
    const mainnet = toMainnetAddress(bcrt, PUBKEY_HEX);
    expect(mainnet).toMatch(/^bc1q/);
    expect(scriptBytesOf(mainnet, MAINNET)).toBe(scriptBytesOf(bcrt, REGTEST));
  });

  it('bcrt1p → bc1p with identical script hash', () => {
    const xonly = PUBKEY.slice(1, 33);
    const bcrt = btc.p2tr(xonly, undefined, REGTEST).address!;
    const mainnet = toMainnetAddress(bcrt, PUBKEY_HEX);
    expect(mainnet).toMatch(/^bc1p/);
    expect(scriptBytesOf(mainnet, MAINNET)).toBe(scriptBytesOf(bcrt, REGTEST));
  });

  it('throws on an unsupported address prefix', () => {
    expect(() => toMainnetAddress('bogus_address', PUBKEY_HEX))
      .toThrow(/unsupported bcrt address type/i);
  });
});

describe('walletSidePaymentAddress', () => {
  const bcrtP2WPKH = btc.p2wpkh(PUBKEY, REGTEST).address!;

  it('translates bcrt → mainnet for mainnet-only wallets on regtest', () => {
    for (const walletType of [
      KnownOrdinalWalletType.leather,
      KnownOrdinalWalletType.unisat,
      KnownOrdinalWalletType.wizz,
      KnownOrdinalWalletType.okx,
    ]) {
      const wallet = walletSidePaymentAddress(walletType, bcrtP2WPKH, PUBKEY_HEX);
      expect(wallet).toMatch(/^bc1q/);
      expect(scriptBytesOf(wallet, MAINNET)).toBe(scriptBytesOf(bcrtP2WPKH, REGTEST));
    }
  });

  it('returns bcrt unchanged for native-regtest wallets', () => {
    for (const walletType of [
      KnownOrdinalWalletType.xverse,
      KnownOrdinalWalletType.cat21wallet,
      KnownOrdinalWalletType.alby,
    ]) {
      expect(walletSidePaymentAddress(walletType, bcrtP2WPKH, PUBKEY_HEX)).toBe(bcrtP2WPKH);
    }
  });

  it('returns non-bcrt (mainnet/testnet) addresses unchanged', () => {
    const mainnet = btc.p2wpkh(PUBKEY, MAINNET).address!;
    for (const walletType of [
      KnownOrdinalWalletType.leather,
      KnownOrdinalWalletType.xverse,
    ]) {
      expect(walletSidePaymentAddress(walletType, mainnet, PUBKEY_HEX)).toBe(mainnet);
    }
  });

  it('returns app address unchanged when no publicKey provided (backwards-compat path)', () => {
    expect(walletSidePaymentAddress(KnownOrdinalWalletType.leather, bcrtP2WPKH, undefined)).toBe(bcrtP2WPKH);
  });
});

describe('toWireNetworkFor', () => {
  it('returns Regtest for native-regtest wallets when the app asked Regtest', () => {
    expect(toWireNetworkFor(KnownOrdinalWalletType.xverse,      Network.Regtest)).toBe(Network.Regtest);
    expect(toWireNetworkFor(KnownOrdinalWalletType.cat21wallet, Network.Regtest)).toBe(Network.Regtest);
    expect(toWireNetworkFor(KnownOrdinalWalletType.alby,        Network.Regtest)).toBe(Network.Regtest);
  });

  it('returns Mainnet for mainnet-only wallets when the app asked Regtest', () => {
    expect(toWireNetworkFor(KnownOrdinalWalletType.leather, Network.Regtest)).toBe(Network.Mainnet);
    expect(toWireNetworkFor(KnownOrdinalWalletType.unisat,  Network.Regtest)).toBe(Network.Mainnet);
    expect(toWireNetworkFor(KnownOrdinalWalletType.wizz,    Network.Regtest)).toBe(Network.Mainnet);
    expect(toWireNetworkFor(KnownOrdinalWalletType.okx,     Network.Regtest)).toBe(Network.Mainnet);
  });

  it('passes non-regtest networks through unchanged (both wallet families)', () => {
    for (const walletType of [
      KnownOrdinalWalletType.xverse,
      KnownOrdinalWalletType.leather,
      KnownOrdinalWalletType.unisat,
    ]) {
      expect(toWireNetworkFor(walletType, Network.Mainnet)).toBe(Network.Mainnet);
      expect(toWireNetworkFor(walletType, Network.Signet)).toBe(Network.Signet);
    }
  });
});
