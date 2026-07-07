/**
 * Bare cat UTXO outpoint — `{ txid, vout }` — the minimum a caller
 * needs to reference a specific cat on chain. Enriched siblings live
 * alongside their orchestrators and extend this shape:
 *
 *   - `Cat21Holding` (transfer): `CatOutpoint & { catNumber; value }`
 *   - `BuyOfferTargetCat` (offer-create): `CatOutpoint & { catNumber; value; scriptPubKey }`
 *   - `ParsedOffer.catUtxo` (offer-accept): re-uses `CatOutpoint`
 *
 * The URL-permalink layer (`permalink.helper.ts`) uses only the
 * bare shape — cat number + value are consumer-side enrichments.
 */
export interface CatOutpoint {
  /** Lowercase 64-hex txid. */
  txid: string;
  /** Zero-based output index. */
  vout: number;
}
