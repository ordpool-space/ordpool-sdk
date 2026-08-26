import { describe, expect, it } from '@jest/globals';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';

import { Network } from '../../network';
import {
  deriveWatchOnlyAddresses,
  watchOnlyScriptType,
} from './derive-watch-only';

const b58c = base58check(sha256);

/**
 * Re-version an extended key's SLIP-132 prefix bytes without touching
 * the key material. Lets the SLIP-132 tests build a valid zpub/ypub
 * from a known-good xpub at runtime instead of hardcoding a
 * transcription-fragile constant (the real zpub/tpub/vpub proof lives
 * in the regtest spec against bitcoin-cli).
 */
function reversion(extendedKey: string, versionBE: number): string {
  const payload = b58c.decode(extendedKey).slice();
  payload[0] = (versionBE >>> 24) & 0xff;
  payload[1] = (versionBE >>> 16) & 0xff;
  payload[2] = (versionBE >>> 8) & 0xff;
  payload[3] = versionBE & 0xff;
  return b58c.encode(payload);
}
const ZPUB_VERSION = 0x04b24746; // SLIP-132 BIP-84 native segwit

/**
 * Official BIP test vectors, all from the same mnemonic
 * "abandon abandon abandon abandon abandon abandon abandon abandon
 *  abandon abandon abandon about". These are documented spec constants,
 * so they pin the derivation against the standards themselves rather
 * than against our own output.
 */
describe('deriveWatchOnlyAddresses — official BIP test vectors', () => {

  // BIP-86 (taproot). Account xpub m/86'/0'/0'. Plain xpub prefix →
  // script-type-ambiguous → scriptType: 'p2tr' required.
  const BIP86_ACCOUNT_XPUB =
    'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ';

  it('BIP-86 receive 0/0 and 0/1 match the spec', () => {
    const [a0, a1] = deriveWatchOnlyAddresses({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      network: Network.Mainnet,
      scriptType: 'p2tr',
      chain: 0,
      count: 2,
    });
    expect(a0.address).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
    expect(a1.address).toBe('bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh');
    expect(a0.path).toBe('0/0');
    expect(a1.path).toBe('0/1');
  });

  it('BIP-86 change 1/0 matches the spec', () => {
    const [c0] = deriveWatchOnlyAddresses({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      network: Network.Mainnet,
      scriptType: 'p2tr',
      chain: 1,
      count: 1,
    });
    expect(c0.address).toBe('bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7');
    expect(c0.path).toBe('1/0');
  });

  // SLIP-132 handling: a zpub prefix must imply p2wpkh and normalize to
  // the same key material as the plain xpub, so deriving from the zpub
  // (implied type) equals deriving from the xpub with scriptType:
  // 'p2wpkh'. Built by version-byte swap so there is no fragile
  // hardcoded zpub; real zpub/tpub/vpub decoding is proven on regtest.
  it('SLIP-132 zpub prefix implies p2wpkh and normalizes to the same key', () => {
    const zpub = reversion(BIP86_ACCOUNT_XPUB, ZPUB_VERSION);
    expect(watchOnlyScriptType(zpub, Network.Mainnet)).toBe('p2wpkh');

    const fromZpub = deriveWatchOnlyAddresses({
      extendedPublicKey: zpub, network: Network.Mainnet, count: 2,
    });
    const fromXpub = deriveWatchOnlyAddresses({
      extendedPublicKey: BIP86_ACCOUNT_XPUB, network: Network.Mainnet, scriptType: 'p2wpkh', count: 2,
    });
    expect(fromZpub.map(a => a.address)).toEqual(fromXpub.map(a => a.address));
    expect(fromZpub[0].address).toMatch(/^bc1q/); // native segwit
  });

  // Testnet/regtest path: a tpub must parse (HDKey defaults to mainnet
  // versions; the helper passes testnet versions explicitly). Regression
  // guard for the "Version mismatch" on tpub that mainnet-only vectors
  // missed. Re-versioning the mainnet xpub to tpub keeps the same key, so
  // the regtest address is the same x-only key under the bcrt HRP.
  it('derives a regtest (tpub) taproot address without a version mismatch', () => {
    const tpub = reversion(BIP86_ACCOUNT_XPUB, 0x043587cf);
    const [a0] = deriveWatchOnlyAddresses({
      extendedPublicKey: tpub,
      network: Network.Regtest,
      scriptType: 'p2tr',
      count: 1,
    });
    expect(a0.address).toMatch(/^bcrt1p/);
    // Same x-only key as the mainnet vector (bech32m payload equal, HRP differs).
    const [m0] = deriveWatchOnlyAddresses({
      extendedPublicKey: BIP86_ACCOUNT_XPUB, network: Network.Mainnet, scriptType: 'p2tr', count: 1,
    });
    expect(a0.publicKeyHex).toBe(m0.publicKeyHex);
  });

  it('returns the compressed pubkey and gap-limit run length', () => {
    const run = deriveWatchOnlyAddresses({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      network: Network.Mainnet,
      scriptType: 'p2tr',
    });
    expect(run.length).toBe(20); // default gap limit
    expect(run[0].publicKeyHex).toMatch(/^0[23][0-9a-f]{64}$/); // 33-byte compressed
  });
});

describe('deriveWatchOnlyAddresses — input validation', () => {
  const BIP86_ACCOUNT_XPUB =
    'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ';

  it('rejects a plain xpub with no scriptType (ambiguous)', () => {
    expect(() => deriveWatchOnlyAddresses({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      network: Network.Mainnet,
    })).toThrow(/ambiguous/);
  });

  it('rejects a scriptType that conflicts with a SLIP-132 prefix', () => {
    const zpub = reversion(BIP86_ACCOUNT_XPUB, ZPUB_VERSION);
    expect(() => deriveWatchOnlyAddresses({
      extendedPublicKey: zpub,
      network: Network.Mainnet,
      scriptType: 'p2tr',
    })).toThrow(/implies p2wpkh/);
  });

  it('rejects a mainnet key on a testnet network', () => {
    expect(() => deriveWatchOnlyAddresses({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      network: Network.Regtest,
      scriptType: 'p2tr',
    })).toThrow(/mainnet extended key but network is/);
  });

  it('rejects garbage', () => {
    expect(() => deriveWatchOnlyAddresses({
      extendedPublicKey: 'not-a-key',
      network: Network.Mainnet,
      scriptType: 'p2tr',
    })).toThrow(/base58check|extended key/);
  });
});
