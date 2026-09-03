/**
 * Watch-only scan / auto-pick (layer 2 of the xpub contract).
 *
 * Layer 1 (`deriveWatchOnlyAddresses`) turns an account extended key
 * into a run of receive addresses. This layer probes those addresses
 * for on-chain state and picks the wallet's active identity, so a
 * consumer doesn't have to make the user choose an index by hand: a
 * cat can sit at any derivation index (the Genesis Cat is not
 * necessarily at index 0), and index-0-only would miss it.
 *
 * Pure (in `/core`): the actual UTXO / cat lookup is a
 * consumer-provided `probe` callback (wired to electrs + the cat
 * index), so this helper holds only the derive → rank logic and all
 * three consumer sites share one identical auto-pick. The regtest
 * proof (`e2e/regtest/watch-only-scan-roundtrip.spec.ts`) wires the
 * probe to real electrs + ordpool-parser.
 *
 * v1 identity model: single-account Taproot, the same model OKX
 * already proves in this codebase (one BIP-86 account, ordinals +
 * payment both derived from it). The pick is split per role because a
 * user's cat and their spendable funds can live at different indexes
 * of the same account:
 *   - ordinals identity = the cat-bearing address, else receive index 0
 *   - payment identity   = the highest-funded address, else receive index 0
 */

import { Network } from '../../network';
import {
  deriveWatchOnlyAddresses,
  WatchOnlyAddress,
  WatchOnlyScriptType,
} from './derive-watch-only';

/** On-chain state of one address, as reported by the consumer's probe. */
export interface AddressProbe {
  /** Address holds at least one spendable (non-cat) UTXO. */
  funded: boolean;
  /** Total spendable value in sats — picks the best payment address. */
  fundedSats?: number;
  /** Address currently holds a CAT-21 cat UTXO. */
  hasCat?: boolean;
}

export interface ScannedAddress {
  address: WatchOnlyAddress;
  probe: AddressProbe;
}

export interface WatchOnlyScanResult {
  /** Every derived receive address in the scanned window, with its probe. */
  scanned: ScannedAddress[];
  /** Best ordinals identity: first cat-bearing address, else receive index 0. */
  ordinals: WatchOnlyAddress;
  /** Best payment identity: highest-funded address, else receive index 0. */
  payment: WatchOnlyAddress;
  /** Why `ordinals` was chosen. */
  ordinalsReason: 'cat' | 'default';
  /** Why `payment` was chosen. */
  paymentReason: 'funds' | 'default';
}

export interface ScanWatchOnlyArgs {
  extendedPublicKey: string;
  network: Network;
  /** Required for a script-type-ambiguous prefix (plain xpub/tpub). */
  scriptType?: WatchOnlyScriptType;
  /** How many receive addresses to derive + probe (default 20, the gap limit). */
  gapLimit?: number;
  /**
   * Consumer-provided on-chain lookup for one address. Wire to electrs
   * `/address/:a/utxo` (funded/fundedSats) + the cat index / ordpool-parser
   * (hasCat). Called once per derived address; may run concurrently.
   */
  probe: (address: string) => Promise<AddressProbe>;
}

/**
 * Derive the receive window, probe every address, and auto-pick the
 * ordinals + payment identities. Probes run concurrently.
 */
export async function scanWatchOnly(args: ScanWatchOnlyArgs): Promise<WatchOnlyScanResult> {
  const gapLimit = args.gapLimit ?? 20;
  if (gapLimit < 1) throw new Error('Watch-only scan: gapLimit must be >= 1');

  const derived = deriveWatchOnlyAddresses({
    extendedPublicKey: args.extendedPublicKey,
    network: args.network,
    scriptType: args.scriptType,
    chain: 0,           // receive chain
    startIndex: 0,
    count: gapLimit,
  });

  const probes = await Promise.all(derived.map((a) => args.probe(a.address)));
  const scanned: ScannedAddress[] = derived.map((address, i) => ({ address, probe: probes[i] }));

  const fallback = derived[0]; // receive index 0 is always the default identity

  // Ordinals: the first (lowest-index) cat-bearing address.
  const catBearer = scanned.find((s) => s.probe.hasCat);
  const ordinals = catBearer?.address ?? fallback;
  const ordinalsReason: 'cat' | 'default' = catBearer ? 'cat' : 'default';

  // Payment: the address with the most spendable sats. Ties resolve to
  // the lowest index (find scans in derivation order).
  let best: ScannedAddress | undefined;
  for (const s of scanned) {
    if (!s.probe.funded) continue;
    const sats = s.probe.fundedSats ?? 0;
    const bestSats = best?.probe.fundedSats ?? 0;
    if (!best || sats > bestSats) best = s;
  }
  const payment = best?.address ?? fallback;
  const paymentReason: 'funds' | 'default' = best ? 'funds' : 'default';

  return { scanned, ordinals, payment, ordinalsReason, paymentReason };
}
