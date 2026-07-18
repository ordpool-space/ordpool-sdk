import { OrdinalsAddress, PaymentAddress } from '../wallet/address-types';

/**
 * A CAT-21 sell listing — the seller's advertised intent to sell a
 * specific cat UTXO at a specific price. Sits between the private
 * "share-a-URL" flow (workspace HARD RULE "Offers can be shared in
 * the wild") and the on-chain buy-offer PSBT flow — a listing is a
 * public advertisement, not a signed transaction.
 *
 * Every field is required so anyone (frontend, backend, mirror,
 * third-party crawler) can reconstruct the canonical signed message
 * from the row alone and re-verify the BIP-322 signature. No trust
 * in cat21-indexer.
 */
export interface Cat21Listing {
  /** Cat number the listing covers. */
  catNumber: number;
  /** Price the seller is asking, in sats. Positive integer. */
  askSats: number;
  /**
   * Where the seller's sale proceeds should land. Branded — same
   * "never derived from an on-chain lookup" guardrail the create-
   * offer orchestrator carries; see the SDK HARD RULE.
   */
  payTo: PaymentAddress;
  /** Cat UTXO the listing is pinned to (intent-lock). Lowercase hex. */
  catTxid: string;
  /** vout of the cat UTXO. */
  catVout: number;
  /**
   * The seller's ordinals address at signing time. This IS the
   * address whose ownership of the cat UTXO the BIP-322 signature
   * proves — the verifier decodes the P2TR script from here to
   * check the schnorr signature. Branded for the same reason as
   * `payTo`: address category is load-bearing.
   */
  ordinalsAddress: OrdinalsAddress;
  /**
   * Unix seconds at signing time. Anti-replay hint — the backend
   * MAY reject listings whose `signedAt` is older than a window
   * (e.g. > 24h in the past) or too far in the future. Also lets
   * the pruner sort by age for eviction ties.
   */
  signedAt: number;
  /**
   * Base64-encoded BIP-322 "simple" signature witness. For P2TR
   * ordinals addresses (the only kind cats live on today) this is
   * the serialized witness stack containing a single 64- or 65-byte
   * schnorr signature. Wallet-generated: Xverse's `signMessage`,
   * Leather's `signMessage`, cat21-wallet's `signMessage`, etc.
   */
  signature: string;
}
