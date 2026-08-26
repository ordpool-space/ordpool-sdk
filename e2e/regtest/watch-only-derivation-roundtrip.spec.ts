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
 * For each active receive descriptor of the bootstrap `ordpool-e2e`
 * wallet (Core auto-generates tr / wpkh / sh(wpkh) / pkh):
 *   1. Read its public descriptor via `listdescriptors`.
 *   2. Extract the account extended key (tpub) + chain suffix.
 *   3. Derive receive addresses 0..N with the SDK helper.
 *   4. Assert byte-equality with `deriveaddresses(descriptor, [0,N])`.
 *
 * Also proves SLIP-132 decoding (vpub) against a real key by
 * re-versioning Core's tpub and asserting identical derivation.
 */

import { describe, expect, it } from '@jest/globals';
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

/**
 * The bootstrap `ordpool-e2e` descriptor wallet already backs every
 * psbt-export spec (bech32 + bech32m both proven), so it carries the
 * full set of active receive descriptors Core auto-generates for a
 * default descriptor wallet (pkh / sh(wpkh) / wpkh / tr). We read its
 * PUBLIC descriptors (xpub form) rather than create new wallets, which
 * avoids the "fresh createwallet has 0 descriptors on this bitcoind"
 * pitfall and reuses the known-good wallet.
 */
const WALLET = 'ordpool-e2e';

describe('watch-only xpub derivation vs bitcoin-cli deriveaddresses (regtest)', () => {

  /** All active receive descriptors of a script type we support. */
  function activeReceiveDescriptors(): { scriptType: WatchOnlyScriptType; desc: string }[] {
    const { descriptors } = JSON.parse(rpc('-rpcwallet=' + WALLET, 'listdescriptors'));
    const out: { scriptType: WatchOnlyScriptType; desc: string }[] = [];
    for (const d of descriptors) {
      const desc: string = d.desc;
      if (!d.active || d.internal !== false) continue;         // receive (external) only
      if (/multi|sortedmulti|combo/.test(desc)) continue;      // single-key descriptors only
      try {
        out.push({ scriptType: scriptTypeOfDescriptor(desc), desc });
      } catch { /* script type we don't derive (e.g. raw) — skip */ }
    }
    return out;
  }

  it('covers the script types the psbt-export specs rely on (tr + wpkh at minimum)', () => {
    const present = new Set(activeReceiveDescriptors().map(d => d.scriptType));
    expect(present.has('p2tr')).toBe(true);
    expect(present.has('p2wpkh')).toBe(true);
  });

  it('SDK derivation byte-matches Core deriveaddresses for every active receive descriptor', () => {
    const descriptors = activeReceiveDescriptors();
    expect(descriptors.length).toBeGreaterThanOrEqual(2);

    for (const { scriptType, desc } of descriptors) {
      const { accountKey, chain } = parseDescriptor(desc);
      expect(chain).toBe(0); // receive descriptor

      // listdescriptors already carries a #checksum; deriveaddresses accepts it as-is.
      const coreAddresses: string[] = JSON.parse(rpc('deriveaddresses', desc, `[0,${N - 1}]`));
      expect(coreAddresses.length).toBe(N);

      const sdk = deriveWatchOnlyAddresses({
        extendedPublicKey: accountKey,
        network: Network.Regtest,
        scriptType,          // tpub is prefix-ambiguous; Core encodes type in the function
        chain: 0,
        count: N,
      });
      expect(sdk.map(a => a.address)).toEqual(coreAddresses);
    }
  });

  it('SLIP-132 vpub decodes to the same key as the plain tpub (real key)', () => {
    const wpkh = activeReceiveDescriptors().find(d => d.scriptType === 'p2wpkh');
    if (!wpkh) throw new Error('no active p2wpkh receive descriptor in ordpool-e2e');
    const { accountKey } = parseDescriptor(wpkh.desc);
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
