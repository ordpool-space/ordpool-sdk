// Pure functions for the pendingMints$ pipeline. Extracted from the
// service so the filter + dedupe logic is testable without touching
// Angular DI, HttpClient mocks, or fake timers.

import { MempoolTx, PendingMint } from './cat21.service.types';

/**
 * A mempool tx counts as a CAT-21 mint for the given query set when:
 *  - its nLockTime is exactly 21 (the protocol marker), and
 *  - its first output's address is one of the addresses we're watching.
 *
 * The "first output" rule is the CAT-21 ownership rule — see
 * cat21/README.md "Ownership": the cat lands on the first sat of the
 * first output. Anything not addressed to one of `querySet` is some
 * other wallet's mint and not our concern.
 */
export function matchesCat21Mint(tx: MempoolTx, querySet: Set<string>): boolean {
  if (tx.locktime !== 21) return false;
  const recipient = tx.vout?.[0]?.scriptpubkey_address;
  if (!recipient) return false;
  return querySet.has(recipient);
}

/**
 * Project a mempool tx onto the PendingMint shape. `seenAt` is passed
 * in by the caller (the orchestrator keeps a first-seen map across
 * polling cycles so the timestamp doesn't reset on every tick).
 */
export function txToPendingMint(tx: MempoolTx, seenAt: string): PendingMint {
  const vsize = Math.ceil(tx.weight / 4);
  return {
    txid: tx.txid,
    vsize,
    fee: tx.fee,
    feeRate: Math.round((tx.fee / vsize) * 10) / 10,
    // A CAT-21 mint's vout[0] is the recipient address output, but an
    // OP_RETURN vout[0] (or an empty vout) has no address; fall back to
    // '' rather than assert non-null.
    recipientAddress: tx.vout[0]?.scriptpubkey_address ?? '',
    seenAt,
  };
}

/**
 * Walk per-address tx arrays, keep only CAT-21 mints addressed at the
 * query set, dedupe by txid (one address might appear in multiple
 * queried sets), assign first-seen timestamps via the supplied map.
 *
 * Side effect: `firstSeen` is mutated in place — new txids get their
 * timestamp added on first sight. Caller can garbage-collect entries
 * for txids that have left the mempool via {@link gcFirstSeen}.
 */
export function selectMatchingPendingMints(
  txArrays: MempoolTx[][],
  querySet: Set<string>,
  firstSeen: Map<string, string>,
  nowIso: string,
): PendingMint[] {
  const seenInThisPass = new Set<string>();
  const result: PendingMint[] = [];

  for (const arr of txArrays) {
    for (const tx of arr) {
      if (seenInThisPass.has(tx.txid)) continue;
      seenInThisPass.add(tx.txid);
      if (!matchesCat21Mint(tx, querySet)) continue;
      if (!firstSeen.has(tx.txid)) firstSeen.set(tx.txid, nowIso);
      result.push(txToPendingMint(tx, firstSeen.get(tx.txid) ?? nowIso));
    }
  }
  return result;
}

/**
 * Drop first-seen entries for txids that are no longer present in the
 * mempool (because they got mined into a block). Keeps the map bounded
 * for long-running sessions.
 */
export function gcFirstSeen(firstSeen: Map<string, string>, currentTxids: Set<string>): void {
  for (const id of firstSeen.keys()) {
    if (!currentTxids.has(id)) firstSeen.delete(id);
  }
}
