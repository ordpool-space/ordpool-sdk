/**
 * One entry per outpoint.
 *
 * Around the moment a transaction confirms, electrs can list the SAME outpoint
 * twice on `/address/<a>/utxo`: once with `status.confirmed: true` and once
 * still unconfirmed. Anything that sums such a list, or renders one row per
 * entry, then double-counts. Observed live on regtest 2026-09-12: two identical
 * `<txid>:0` entries of 500 000 sats for an address that had received 500 000
 * once.
 *
 * Both copies describe the same output and therefore carry the same value, so
 * which one survives cannot matter; only that one does. The first is kept, so
 * the endpoint's own ordering is otherwise preserved.
 *
 * This lives here, and every UTXO source in the SDK runs its result through it,
 * because the alternative is each consumer remembering a quirk of an indexer
 * they never call directly.
 */
export function dedupeUtxosByOutpoint<T extends { txid: string; vout: number }>(
  utxos: ReadonlyArray<T>,
): T[] {
  const byOutpoint = new Map<string, T>();
  for (const utxo of utxos) {
    const key = `${utxo.txid}:${utxo.vout}`;
    if (!byOutpoint.has(key)) byOutpoint.set(key, utxo);
  }
  return [...byOutpoint.values()];
}
