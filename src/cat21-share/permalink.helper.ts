/**
 * Permalink helpers for the three cat21-flow surfaces that ship a URL:
 *
 *   - **Ask permalink** — a seller publishes "I want to sell cat #N for X sats"
 *     as `/cat/N?ask=X`. Rendered by the cat detail page; anyone can view.
 *   - **Buy permalink** — a buyer clicks an ask link and lands on the
 *     make-offer surface prefilled with `catNumber` + `askPrice`. The
 *     `fromAsk` flag surfaces a "responding to an ask" banner so the
 *     buyer knows the price came from the seller, not their own guess.
 *   - **Accept-offer permalink** — after the buyer signs the offer PSBT
 *     they hand the seller a one-click link:
 *     `/dashboard/trade/accept?offer=<base64>&catTxid=<txid>&catVout=<n>`.
 *     Seller opens it, floor is auto-set to 0 (they consented by
 *     clicking the link), signs, cat moves on-chain.
 *
 * The SDK owns the QUERY shape (param names + encoding), consumers own
 * the URL PATH. Two consumers today — cat21.space (Path 1 via
 * cat21-indexer/frontend) and cat21-wallet manual/agent UIs (Path 2/3)
 * — share the same query names so a permalink minted by one is
 * consumable by the other.
 *
 * See workspace HARD RULE "Offers can be shared in the wild" in
 * `/Work/ordpool/CLAUDE.md` and its SDK companion. Distribution is
 * *not* the security boundary; the sniping-proof PSBT structure is.
 *
 * Pure functions. No Angular, no I/O.
 */

import { PaymentAddress, toPaymentAddress } from '../wallet/address-types';
import { CatOutpoint } from './cat-outpoint';

/** Query param keys — single source of truth. */
export const CAT21_QUERY_KEYS = {
  /** `/cat/N?ask=<sats>` — seller advertises a price. */
  ask: 'ask',
  /**
   * `?payTo=<address>` — seller's PAYMENT address (from the seller's
   * own wallet). Carried in ask + buy-offer permalinks so the buyer
   * NEVER has to derive it from an on-chain owner lookup — the on-
   * chain owner is the seller's ORDINALS address (that's where cats
   * live). See the HARD RULE "Never derive a payment address from an
   * on-chain lookup" in the SDK CLAUDE.md.
   */
  payTo: 'payTo',
  /** `?catNumber=<n>` — pre-fill for make-offer or transfer. */
  catNumber: 'catNumber',
  /** `?askPrice=<sats>` — buyer-side landing knows what the seller asked. */
  askPrice: 'askPrice',
  /** `?fromAsk=1` — buyer-side banner "responding to an ask". */
  fromAsk: 'fromAsk',
  /** `?offer=<base64>` — the buyer-signed PSBT bytes to hand the seller. */
  offer: 'offer',
  /** `?catTxid=<64-hex>` — one half of the cat outpoint (matches offer input 0). */
  catTxid: 'catTxid',
  /** `?catVout=<uint>` — other half of the cat outpoint. */
  catVout: 'catVout',
} as const;

const TXID_RE = /^[0-9a-f]{64}$/i;

// ---------- Ask permalink ----------

export interface AskQueryArgs {
  /** Price the seller is asking, in sats. Must be a positive integer. */
  askSats: number;
  /**
   * Seller's PAYMENT address — the address the buyer's PSBT should
   * route the payment output to. Optional in the type so legacy /
   * "make-me-an-offer" ask links still parse, but ALWAYS include it
   * when the seller's wallet is connected (the sell-modal on
   * cat21.space does this). Without it, the buyer's make-offer page
   * has no way to know where to send the sats without asking out-of-
   * band — the deep-link's whole point collapses.
   *
   * Do not populate from an on-chain owner lookup — that returns the
   * seller's ORDINALS address, which is the wrong one. See the HARD
   * RULE "Never derive a payment address from an on-chain lookup"
   * in the SDK CLAUDE.md.
   */
  sellerPaymentAddress?: string;
}

export interface ParsedAskQuery {
  askSats: number | null;
  /**
   * Branded because the `payTo=` URL param IS the seller's payment
   * address by construction — the seller's own wallet emitted it at
   * sell-modal time. The parser has enough context to hand it back
   * pre-branded so consumers don't have to re-cast at every callsite.
   */
  sellerPaymentAddress: PaymentAddress | null;
}

/**
 * Build the query params for an ask permalink. Consumer concatenates
 * with its own detail path, e.g. `${origin}/cat/${n}?${new URLSearchParams(query)}`.
 */
export function buildAskQueryParams(args: AskQueryArgs): Record<string, string> {
  if (!Number.isInteger(args.askSats) || args.askSats <= 0) {
    throw new Error(`askSats must be a positive integer; got ${args.askSats}`);
  }
  const out: Record<string, string> = { [CAT21_QUERY_KEYS.ask]: String(args.askSats) };
  if (args.sellerPaymentAddress !== undefined) {
    // Validate via the canonical shape check (throws on garbage).
    out[CAT21_QUERY_KEYS.payTo] = toPaymentAddress(args.sellerPaymentAddress);
  }
  return out;
}

/**
 * Parse an ask-query. Returns `askSats` and `sellerPaymentAddress`
 * as separate nullables — a link with only `ask=` (legacy) parses
 * with `sellerPaymentAddress: null`; a link missing / malformed
 * `ask=` parses with `askSats: null`. Tampered addresses (garbage,
 * wrong HRP) come back as null; consumer's own address validator
 * still runs before signing.
 */
export function parseAskQueryParams(
  query: URLSearchParams | Record<string, string | null>,
): ParsedAskQuery {
  return {
    askSats: parseIntParam(readParam(query, CAT21_QUERY_KEYS.ask), (n) => n > 0),
    sellerPaymentAddress: parseAddressParam(readParam(query, CAT21_QUERY_KEYS.payTo)),
  };
}

// ---------- Buy-offer permalink (ask → make-offer landing) ----------

export interface BuyOfferQueryArgs {
  /** Cat the buyer wants to bid on. */
  catNumber: number;
  /** Ask price from the seller's link, in sats. Optional — a plain
   *  "make me an offer" link is fine too. */
  askSats?: number;
  /**
   * Seller's PAYMENT address forwarded from the ask permalink. See
   * `AskQueryArgs.sellerPaymentAddress` for the why.
   */
  sellerPaymentAddress?: string;
}

export interface ParsedBuyOfferQuery {
  catNumber: number | null;
  askSats: number | null;
  fromAsk: boolean;
  /** Branded — see `ParsedAskQuery.sellerPaymentAddress`. */
  sellerPaymentAddress: PaymentAddress | null;
}

export function buildBuyOfferQueryParams(args: BuyOfferQueryArgs): Record<string, string> {
  if (!Number.isInteger(args.catNumber) || args.catNumber < 0) {
    throw new Error(`catNumber must be a non-negative integer; got ${args.catNumber}`);
  }
  const params: Record<string, string> = {
    [CAT21_QUERY_KEYS.catNumber]: String(args.catNumber),
  };
  if (args.askSats !== undefined) {
    if (!Number.isInteger(args.askSats) || args.askSats <= 0) {
      throw new Error(`askSats must be a positive integer; got ${args.askSats}`);
    }
    params[CAT21_QUERY_KEYS.askPrice] = String(args.askSats);
    params[CAT21_QUERY_KEYS.fromAsk] = '1';
  }
  if (args.sellerPaymentAddress !== undefined) {
    params[CAT21_QUERY_KEYS.payTo] = toPaymentAddress(args.sellerPaymentAddress);
  }
  return params;
}

export function parseBuyOfferQueryParams(
  query: URLSearchParams | Record<string, string | null>,
): ParsedBuyOfferQuery {
  return {
    catNumber: parseIntParam(readParam(query, CAT21_QUERY_KEYS.catNumber), (n) => n >= 0),
    askSats: parseIntParam(readParam(query, CAT21_QUERY_KEYS.askPrice), (n) => n > 0),
    fromAsk: readParam(query, CAT21_QUERY_KEYS.fromAsk) === '1',
    sellerPaymentAddress: parseAddressParam(readParam(query, CAT21_QUERY_KEYS.payTo)),
  };
}

// ---------- Accept-offer permalink (buyer → seller one-click) ----------

export interface AcceptOfferQueryArgs {
  /** Buyer-signed PSBT bytes, already base64-encoded. */
  offerBase64: string;
  /**
   * Cat outpoint the offer targets (matches offer input 0). Optional
   * — without it the accept page falls back to the seller's cat-picker.
   * Include it whenever the buyer knows the outpoint (typical for the
   * make-offer success flow) so the seller gets a true one-click accept.
   */
  catOutpoint?: CatOutpoint;
}

export function buildAcceptOfferQueryParams(args: AcceptOfferQueryArgs): Record<string, string> {
  if (!args.offerBase64 || typeof args.offerBase64 !== 'string') {
    throw new Error('offerBase64 must be a non-empty string');
  }
  const params: Record<string, string> = {
    [CAT21_QUERY_KEYS.offer]: args.offerBase64,
  };
  if (args.catOutpoint) {
    assertCatOutpoint(args.catOutpoint);
    params[CAT21_QUERY_KEYS.catTxid] = args.catOutpoint.txid.toLowerCase();
    params[CAT21_QUERY_KEYS.catVout] = String(args.catOutpoint.vout);
  }
  return params;
}

export function parseAcceptOfferQueryParams(
  query: URLSearchParams | Record<string, string | null>,
): { offerBase64: string | null; catOutpoint: CatOutpoint | null; bundleComplete: boolean } {
  const offerBase64 = readParam(query, CAT21_QUERY_KEYS.offer);
  const catOutpoint = parseCatOutpointParams(query);
  return {
    offerBase64,
    catOutpoint,
    bundleComplete: !!offerBase64 && !!catOutpoint,
  };
}

// ---------- Transfer permalink (send from detail page) ----------

export interface TransferQueryArgs {
  /** Cat the sender is transferring. */
  catNumber: number;
  /** Cat outpoint. Optional — the transfer page falls back to picker if omitted. */
  catOutpoint?: CatOutpoint;
}

export function buildTransferQueryParams(args: TransferQueryArgs): Record<string, string> {
  if (!Number.isInteger(args.catNumber) || args.catNumber < 0) {
    throw new Error(`catNumber must be a non-negative integer; got ${args.catNumber}`);
  }
  const params: Record<string, string> = {
    [CAT21_QUERY_KEYS.catNumber]: String(args.catNumber),
  };
  if (args.catOutpoint) {
    assertCatOutpoint(args.catOutpoint);
    params[CAT21_QUERY_KEYS.catTxid] = args.catOutpoint.txid.toLowerCase();
    params[CAT21_QUERY_KEYS.catVout] = String(args.catOutpoint.vout);
  }
  return params;
}

export function parseTransferQueryParams(
  query: URLSearchParams | Record<string, string | null>,
): { catNumber: number | null; catOutpoint: CatOutpoint | null } {
  return {
    catNumber: parseIntParam(readParam(query, CAT21_QUERY_KEYS.catNumber), (n) => n >= 0),
    catOutpoint: parseCatOutpointParams(query),
  };
}

// ---------- Internals ----------

function readParam(
  query: URLSearchParams | Record<string, string | null>,
  key: string,
): string | null {
  return query instanceof URLSearchParams ? query.get(key) : query[key] ?? null;
}

function parseIntParam(raw: string | null, guard: (n: number) => boolean): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || !guard(n) || String(n) !== raw) return null;
  return n;
}

function parseCatOutpointParams(
  query: URLSearchParams | Record<string, string | null>,
): CatOutpoint | null {
  const txidRaw = readParam(query, CAT21_QUERY_KEYS.catTxid);
  const voutRaw = readParam(query, CAT21_QUERY_KEYS.catVout);
  if (!txidRaw || !voutRaw) return null;
  const txid = txidRaw.toLowerCase();
  if (!TXID_RE.test(txid)) return null;
  const vout = parseIntParam(voutRaw, (n) => n >= 0);
  if (vout === null) return null;
  return { txid, vout };
}

function assertCatOutpoint(o: CatOutpoint): void {
  if (!TXID_RE.test(o.txid)) {
    throw new Error(`catOutpoint.txid must be 64-hex; got ${o.txid.length} chars`);
  }
  if (!Number.isInteger(o.vout) || o.vout < 0) {
    throw new Error(`catOutpoint.vout must be a non-negative integer; got ${o.vout}`);
  }
}

/**
 * Parser-side counterpart to `toPaymentAddress`. Malformed values
 * silently return null so a tampered link degrades to "field missing"
 * rather than crashing the page. The consumer's own address decoder
 * (scure `btc.Address(...).decode`) runs before signing anyway, so
 * this is defence-in-depth.
 *
 * The return type is `PaymentAddress | null` because the ONLY place
 * this parser is used is `payTo=` — the URL param defined as the
 * seller's payment address. Branding at ingress means downstream
 * consumers don't repeat the `toPaymentAddress()` cast at every hop.
 *
 * Routes through `toPaymentAddress` (single source of truth for the
 * shape check); swallows its throw and returns null on invalid input.
 */
function parseAddressParam(raw: string | null): PaymentAddress | null {
  if (raw === null) return null;
  try {
    return toPaymentAddress(raw);
  } catch {
    return null;
  }
}
