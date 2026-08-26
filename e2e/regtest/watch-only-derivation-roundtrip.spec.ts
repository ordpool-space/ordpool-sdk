/**
 * Watch-only xpub derivation proven against bitcoin-cli on regtest.
 *
 * The unit test (`src/wallet/xpub/derive-watch-only.spec.ts`) pins the
 * derivation against official BIP-84/86 vectors. This proves it against
 * Bitcoin Core's OWN descriptor derivation for every script type: if
 * `deriveWatchOnlyAddresses` produces the same addresses Core's
 * `deriveaddresses` does from the same account extended key, the SDK's
 * watch-only identity derivation is correct by construction for the
 * canonical BIP-174 signer — the same wallet the psbt-export specs use.
 *
 * For each script type (tr, wpkh, sh(wpkh), pkh):
 *   1. Create a fresh descriptor wallet of that type.
 *   2. Read its public receive descriptor via `listdescriptors`.
 *   3. Extract the account extended key (tpub) + chain suffix.
 *   4. Derive receive addresses 0..N with the SDK helper.
 *   5. Assert byte-equality with `deriveaddresses(descriptor, [0,N])`.
 *
 * Also proves SLIP-132 decoding (vpub) against a real key by
 * re-versioning Core's tpub and asserting identical derivation.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';

import { Network } from '../../src/network';
import {
  deriveWatchOnlyAddresses,
  WatchOnlyScriptType,
} from '../../src/wallet/xpub/derive-watch-only';
import { rpc } from './regtest-helpers';

const b58c = base58check(sha256);

/** Map a descriptor function to our script-type enum. */
function scriptTypeOfDescriptor(desc: string): WatchOnlyScriptType {
  if (desc.startsWith('tr(')) return 'p2tr';
  if (desc.startsWith('sh(wpkh(')) return 'p2sh-p2wpkh';
  if (desc.startsWith('wpkh(')) return 'p2wpkh';
  if (desc.startsWith('pkh(')) return 'p2pkh';
  throw new Error(`unhandled descriptor function: ${desc}`);
}

/** Extract the account-level tpub and the chain (0/1) from a Core descriptor. */
function parseDescriptor(desc: string): { accountKey: string; chain: 0 | 1 } {
  const key = /((?:tpub|xpub)[1-9A-HJ-NP-Za-km-z]+)\/([01])\/\*/.exec(desc);
  if (!key) throw new Error(`cannot parse account key + chain from: ${desc}`);
  return { accountKey: key[1], chain: Number(key[2]) as 0 | 1 };
}

/** Strip the `#checksum` suffix if present, then let Core re-add it. */
function withChecksum(desc: string): string {
  const bare = desc.replace(/#.*$/, '');
  const info = JSON.parse(rpc('getdescriptorinfo', bare));
  return `${bare}#${info.checksum}`;
}

/** Re-version an extended key's prefix bytes (SLIP-132 normalization test). */
function reversion(extendedKey: string, versionBE: number): string {
  const payload = b58c.decode(extendedKey).slice();
  payload[0] = (versionBE >>> 24) & 0xff;
  payload[1] = (versionBE >>> 16) & 0xff;
  payload[2] = (versionBE >>> 8) & 0xff;
  payload[3] = versionBE & 0xff;
  return b58c.encode(payload);
}

const N = 5; // addresses per script type

describe('watch-only xpub derivation vs bitcoin-cli deriveaddresses (regtest)', () => {

  // Fresh descriptor wallets, one per script type. Created blank +
  // private so listdescriptors returns real keys.
  const wallets: Record<WatchOnlyScriptType, string> = {
    'p2tr': 'wo-deriv-tr',
    'p2wpkh': 'wo-deriv-wpkh',
    'p2sh-p2wpkh': 'wo-deriv-shwpkh',
    'p2pkh': 'wo-deriv-pkh',
  };

  beforeAll(() => {
    for (const name of Object.values(wallets)) {
      // descriptors=true (default on modern Core); ignore "already exists".
      try { rpc('createwallet', name); } catch { /* exists from a prior run */ }
    }
  });

  /** The receive descriptor of the requested script type for a wallet. */
  function receiveDescriptor(wallet: string, want: WatchOnlyScriptType): string {
    const { descriptors } = JSON.parse(rpc('-rpcwallet=' + wallet, 'listdescriptors'));
    for (const d of descriptors) {
      const desc: string = d.desc;
      if (d.active && d.internal === false && scriptTypeOfDescriptor(desc) === want) {
        return desc;
      }
    }
    throw new Error(`no active receive ${want} descriptor in ${wallet}`);
  }

  for (const scriptType of Object.keys(wallets) as WatchOnlyScriptType[]) {
    it(`${scriptType}: SDK derivation byte-matches Core deriveaddresses`, () => {
      const desc = receiveDescriptor(wallets[scriptType], scriptType);
      const { accountKey, chain } = parseDescriptor(desc);
      expect(chain).toBe(0); // receive descriptor

      const coreAddresses: string[] = JSON.parse(
        rpc('deriveaddresses', withChecksum(desc), `[0,${N - 1}]`),
      );
      expect(coreAddresses.length).toBe(N);

      const sdk = deriveWatchOnlyAddresses({
        extendedPublicKey: accountKey,
        network: Network.Regtest,
        scriptType,          // tpub is prefix-ambiguous; Core encodes type in the function
        chain: 0,
        count: N,
      });
      expect(sdk.map(a => a.address)).toEqual(coreAddresses);
    });
  }

  it('SLIP-132 vpub decodes to the same key as the plain tpub (real key)', () => {
    const desc = receiveDescriptor(wallets['p2wpkh'], 'p2wpkh');
    const { accountKey } = parseDescriptor(desc);
    const vpub = reversion(accountKey, 0x045f1cf6); // SLIP-132 BIP-84 testnet

    const fromTpub = deriveWatchOnlyAddresses({
      extendedPublicKey: accountKey, network: Network.Regtest, scriptType: 'p2wpkh', count: N,
    });
    const fromVpub = deriveWatchOnlyAddresses({
      extendedPublicKey: vpub, network: Network.Regtest, count: N, // vpub implies p2wpkh
    });
    expect(fromVpub.map(a => a.address)).toEqual(fromTpub.map(a => a.address));
  });
});
