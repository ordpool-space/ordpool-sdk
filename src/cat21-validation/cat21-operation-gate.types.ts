/**
 * Bulletproof gate types for the four cat21 mutating operations.
 *
 * Single entry point: `validateCat21Operation({ config, operation })`
 * returns a discriminated `{ ok: true, resources } | { ok: false,
 * reason, detail? }`. This replaces every per-flow "invariants"
 * module that consumers used to maintain themselves.
 *
 * Design rules:
 *   - Each rejection reason is one test case. No catch-all
 *     `'invalid-intent'` reasons; every shape of malformed input
 *     gets a named reason the consumer can dispatch on.
 *   - The `resources` field on success carries pre-decoded values
 *     (recipient scriptPubKey, parsed catId pieces, ...) so the
 *     downstream builder / rpc-service doesn't re-decode. One pass
 *     of `btc.Address(...).decode(...)` per field, not three.
 *   - Config is wholly optional except for `network`. Consumers that
 *     don't want caps can pass `{ network }`; consumers that want
 *     wallet-policy caps pass `maxFeeRatePerVbyte`, etc.
 *   - No `Validated<I>` brand. Type narrowing happens via the
 *     discriminated union return type, which is a runtime witness
 *     the gate produced.
 */

import { type Network } from '../network';

/* ──────────────────────────  Intent shapes  ────────────────────────── */

/**
 * Intent shape for `cat21_mint`. The user/agent declares the recipient,
 * the fee rate, and an optional developer tip. Everything else (UTXO
 * pick, change address, lockTime, sequence) is the SDK's job.
 */
export interface Cat21MintIntent {
  /** Bitcoin address where the freshly-minted cat lands. */
  recipient: string;
  /** sat/vB the caller is willing to pay. */
  feeRate: number;
  /**
   * Optional developer tip. Set `value` to 0 to skip the output even
   * if the field is present.
   */
  tip?: { address: string; value: number };
}

/**
 * Intent shape for `cat21_transfer`. The cat moves from the active
 * account to `recipient` via ordinal-theory FIFO (cat UTXO at input
 * 0 → cat output at output 0).
 */
export interface Cat21TransferIntent {
  /** Inscription id of the cat to transfer (`<txid>i<index>`). */
  catId: string;
  recipient: string;
  feeRate: number;
}

/**
 * Intent shape for `cat21_create_offer`. Does NOT broadcast — emits
 * a structured listing the agent forwards to a marketplace.
 */
export interface Cat21CreateOfferIntent {
  catId: string;
  /** Price in sats the seller asks. */
  priceSats: number;
  /** Where the seller payment lands (typically the wallet's own address). */
  paymentAddress: string;
}

/**
 * Intent shape for `cat21_accept_offer`. Seller signs an inbound buy
 * PSBT after asserting all four expected fields match.
 */
export interface Cat21AcceptOfferIntent {
  /** Inbound PSBT bytes (base64 OR hex; the gate detects which). */
  offerPsbt: string;
  expectedCatId: string;
  expectedPriceSats: number;
  expectedSellerUtxo: { txid: string; vout: number };
}

/**
 * Intent shape for `cat21_buy` — the BUYER side of the marketplace.
 *
 * The buyer bids on a listed cat: the wallet builds a buy-offer PSBT
 * (`buildCat21BuyOfferPsbt`), funds it with the buyer's own UTXOs,
 * signs the buyer inputs (SIGHASH_ALL, inputs 1..N — NOT input 0, the
 * seller's cat), and POSTs the half-signed PSBT as a bid. It does NOT
 * broadcast; the seller broadcasts on accept. Bidding at exactly the
 * ask price is "buy at asking price".
 *
 * `sellerPaymentAddress` MUST come from the listing (the ask-link's
 * `payTo` param or the listing GET), NEVER from an on-chain owner
 * lookup — that's the 2026-07-18 payment-address-provenance rule.
 * The buyer's own receive (ordinals) + change (payment) addresses are
 * resolved by the wallet from its keychain, not carried here.
 */
export interface Cat21BuyIntent {
  /** Inscription id of the cat to bid on (`<txid>i<index>`). */
  catId: string;
  /** Net sats offered to the seller (output 1 will be bidSats + the seller's cat-UTXO value). */
  bidSats: number;
  /** Seller's payout address, from the listing. Where the BTC lands. */
  sellerPaymentAddress: string;
  feeRate: number;
}

/**
 * Discriminated union over the four cat21 mutating operations the
 * gate validates. The `kind` field is the same string the wallet's
 * RPC method name uses (cat21_mint → 'mint', etc.) so consumer-side
 * dispatch is one switch.
 *
 * Inscribe is a DIFFERENT protocol (ord envelope, lockTime=0, no
 * `nLockTime=21` marker) and lives in `inscribe-validation/` as
 * `validateInscribeOperation`. Do not extend this union with an
 * inscribe variant; the protocols are validated separately.
 */
export type Cat21Operation =
  | { kind: 'mint'; intent: Cat21MintIntent }
  | { kind: 'transfer'; intent: Cat21TransferIntent }
  | { kind: 'create_offer'; intent: Cat21CreateOfferIntent }
  | { kind: 'accept_offer'; intent: Cat21AcceptOfferIntent }
  | { kind: 'buy'; intent: Cat21BuyIntent };

/* ──────────────────────────  Config shapes  ────────────────────────── */

/**
 * Per-call gate config. `network` is required so address decode knows
 * which prefix to expect. Everything else is optional and named so
 * the failure mode of "passing nothing" is the most permissive
 * stance: any address, any fee rate (positive), any price (positive),
 * no allowlists.
 */
export interface Cat21OperationGateConfig {
  /** Wallet's active network. Address checks key off this. */
  network: Network;

  /**
   * Hard ceiling on fee rate. Recommend 1000 sat/vB as a "you typed
   * something wrong" backstop (real congestion has peaked ~700).
   * When unset, only `feeRate > 0` is enforced.
   */
  maxFeeRatePerVbyte?: number;

  /**
   * Hard ceiling on price-related values (mint tip, offer price).
   * When unset, only positivity is enforced. Suggested wallet value:
   * 21 * 1e8 * 10 (21 BTC × 10) so a fat-finger 21000000000 doesn't
   * empty the wallet.
   */
  maxPriceSats?: number;

  /**
   * Hard ceiling on a single tip output's value. Defaults to
   * `maxPriceSats` when unset. Set lower to enforce "tips can't
   * exceed N sats" separately from main price.
   */
  maxTipValueSats?: number;

  /**
   * The wallet's own payment address. When provided, the gate
   * rejects operations that would send the cat / payment to the
   * same address (`'self-send'` reason). Skipped when unset.
   */
  ownPaymentAddress?: string;

  /**
   * Positive recipient allowlist. When set and non-empty, the
   * recipient address MUST be in the list. When unset or empty,
   * any well-formed address on the configured network passes.
   */
  allowedRecipients?: ReadonlyArray<string>;

  /**
   * Positive counterparty allowlist for `create_offer`'s
   * `paymentAddress` and (future) accept-offer destinations. Same
   * semantics as `allowedRecipients`.
   */
  allowedCounterparties?: ReadonlyArray<string>;

  /**
   * Maximum size in decoded bytes of an inbound `offerPsbt` on
   * `accept_offer`. Default 128 KiB (real offers are ~600 bytes).
   * DoS guard against an agent flooding the wallet with a giant
   * PSBT to OOM the popup's PSBT parser.
   */
  maxOfferPsbtBytes?: number;

  /**
   * Positive allowlist on the operation kind itself. When set and
   * non-empty, ONLY the listed operation kinds are accepted; any
   * other kind is rejected with `operation-kind-not-allowed`.
   *
   * Use case: an agent identity is provisioned with "mint only" or
   * "no offer creation". The wallet builds a config carrying just
   * `['mint']` and feeds it to every gate call from that agent;
   * transfer / offer attempts fail closed with a typed reason
   * (no silent acceptance).
   *
   * When unset or empty array → all four kinds accepted (default
   * permissive).
   */
  allowedOperations?: ReadonlyArray<'mint' | 'transfer' | 'create_offer' | 'accept_offer' | 'buy'>;
}

/* ──────────────────────────  Result shapes  ────────────────────────── */

/**
 * The closed set of rejection reasons. Each variant maps 1:1 to one
 * test case in `cat21-operation-gate.spec.ts`. Consumer dispatch on
 * this union is exhaustive (TS catches additions).
 */
export type Cat21GateRejectReason =
  // Generic shape errors
  | 'intent-not-an-object'
  | 'unsupported-operation-kind'
  | 'operation-kind-not-allowed'

  // Address validation (recipient, tip, payment, counterparty)
  | 'recipient-not-a-bitcoin-address'
  | 'recipient-wrong-network'
  | 'recipient-not-allowed'
  | 'self-send'
  | 'tip-address-not-a-bitcoin-address'
  | 'tip-address-wrong-network'
  | 'payment-address-not-a-bitcoin-address'
  | 'payment-address-wrong-network'
  | 'payment-address-not-allowed'

  // Fee rate
  | 'fee-rate-not-finite-number'
  | 'fee-rate-not-positive'
  | 'fee-rate-not-integer'
  | 'fee-rate-above-cap'

  // Tip value
  | 'tip-value-not-finite-number'
  | 'tip-value-not-integer'
  | 'tip-value-negative'
  | 'tip-value-above-cap'

  // Cat id (transfer, create_offer)
  | 'cat-id-malformed'

  // Price (create_offer)
  | 'price-not-finite-number'
  | 'price-not-positive'
  | 'price-not-integer'
  | 'price-below-postage-floor'
  | 'price-above-cap'

  // Accept-offer specifics
  | 'expected-cat-id-malformed'
  | 'expected-price-not-finite-number'
  | 'expected-price-not-positive'
  | 'expected-price-not-integer'
  | 'expected-seller-utxo-malformed'
  | 'offer-psbt-malformed'
  | 'offer-psbt-missing-magic-bytes'
  | 'offer-psbt-too-large';

/**
 * Pre-decoded resources the gate hands the downstream caller on
 * success. Saves the caller from decoding the same things again.
 *
 * Discriminated by the operation kind so TS narrows correctly.
 */
export type Cat21GateResources =
  | {
      kind: 'mint';
      recipientScript: Uint8Array;
      tipScript: Uint8Array | undefined;
    }
  | {
      kind: 'transfer';
      recipientScript: Uint8Array;
      catTxid: string;
      catIndex: number;
    }
  | {
      kind: 'create_offer';
      paymentScript: Uint8Array;
      catTxid: string;
      catIndex: number;
    }
  | {
      kind: 'accept_offer';
      offerPsbtBytes: Uint8Array;
      catTxid: string;
      catIndex: number;
    }
  | {
      kind: 'buy';
      /** Seller payout scriptPubKey decoded from sellerPaymentAddress. */
      sellerPaymentScript: Uint8Array;
      catTxid: string;
      catIndex: number;
    };

export type Cat21OperationGateResult =
  | { ok: true; resources: Cat21GateResources }
  | { ok: false; reason: Cat21GateRejectReason; detail?: string };
