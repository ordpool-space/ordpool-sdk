import { CoreFundingUtxo, UtxosPort } from './ports.js';

/**
 * A minimal reactive snapshot container shared by the operation orchestrators
 * (mint, transfer, create-offer, inscribe). It holds the current snapshot and a
 * listener set, pushes the current value to a new subscriber immediately, and
 * replaces-and-notifies on every patch. The orchestrators compose this rather
 * than each re-implementing the same `snap` + `listeners` + subscribe/patch
 * plumbing; the operation-specific recompute and build logic stays in each
 * orchestrator.
 */
export class SnapshotStore<T extends object> {
  private current: T;
  private readonly listeners = new Set<(s: T) => void>();

  constructor(initial: T) {
    this.current = initial;
  }

  get snapshot(): T {
    return this.current;
  }

  subscribe(listener: (s: T) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  patch(next: Partial<T>): void {
    this.current = { ...this.current, ...next };
    for (const l of this.listeners) l(this.current);
  }
}

/** The minimal UTXO shape the core funding selector reads. `TxnOutput` satisfies it. */
type UtxoLike = { txid: string; vout: number; value: number; transactionHex?: string };

/** Map a wallet UTXO to the core funding shape the pure selectors consume. */
export function toCoreFundingUtxo(u: UtxoLike): CoreFundingUtxo {
  return { txid: u.txid, vout: u.vout, value: u.value, transactionHex: u.transactionHex };
}

/**
 * Build the `UtxosPort` the core selectors take, from the orchestrator's held
 * UTXO set. The set is snapshotted at call time so a later refresh does not
 * mutate an in-flight selection.
 */
export function makeUtxosPort(utxos: readonly UtxoLike[]): UtxosPort {
  const snapshot = [...utxos];
  return { spendableUtxos: async (): Promise<CoreFundingUtxo[]> => snapshot.map(toCoreFundingUtxo) };
}

/**
 * Outpoint-equality for a funding selection. `setSelectedFundingUtxo` recomputes,
 * so re-applying an unchanged selection would loop a consumer that re-drives it
 * from the snapshot; a refreshed row for the same coin is not a change.
 */
export function sameSelection(
  a: { txid: string; vout: number } | null,
  b: { txid: string; vout: number } | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.txid === b.txid && a.vout === b.vout;
}
