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

/** Query param keys — single source of truth. */
export const CAT21_QUERY_KEYS = {
  /** `/cat/N?ask=<sats>` — seller advertises a price. */
  ask: 'ask',
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

/** Cat outpoint carried in URLs (accept-offer, transfer). */
export interface CatOutpoint {
  /** Lowercase 64-hex txid. */
  txid: string;
  /** Zero-based vout index. */
  vout: number;
}

const TXID_RE = /^[0-9a-f]{64}$/i;

// ---------- Ask permalink ----------

export interface AskQueryArgs {
  /** Price the seller is asking, in sats. Must be a positive integer. */
  askSats: number;
}

/**
 * Build the query params for an ask permalink. Consumer concatenates
 * with its own detail path, e.g. `${origin}/cat/${n}?${new URLSearchParams(query)}`.
 */
export function buildAskQueryParams(args: AskQueryArgs): Record<string, string> {
  if (!Number.isInteger(args.askSats) || args.askSats <= 0) {
    throw new Error(`askSats must be a positive integer; got ${args.askSats}`);
  }
  return { [CAT21_QUERY_KEYS.ask]: String(args.askSats) };
}

/**
 * Parse an ask-query. Returns the ask value in sats when the `ask`
 * param is a positive integer; `null` when missing or malformed
 * (defence-in-depth against tampered links).
 */
export function parseAskQueryParams(
  query: URLSearchParams | Record<string, string | null>,
): number | null {
  return parseIntParam(readParam(query, CAT21_QUERY_KEYS.ask), (n) => n > 0);
}

// ---------- Buy-offer permalink (ask → make-offer landing) ----------

export interface BuyOfferQueryArgs {
  /** Cat the buyer wants to bid on. */
  catNumber: number;
  /** Ask price from the seller's link, in sats. Optional — a plain
   *  "make me an offer" link is fine too. */
  askSats?: number;
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
  return params;
}

export function parseBuyOfferQueryParams(
  query: URLSearchParams | Record<string, string | null>,
): { catNumber: number | null; askSats: number | null; fromAsk: boolean } {
  const catNumber = parseIntParam(readParam(query, CAT21_QUERY_KEYS.catNumber), (n) => n >= 0);
  const askSats = parseIntParam(readParam(query, CAT21_QUERY_KEYS.askPrice), (n) => n > 0);
  const fromAsk = readParam(query, CAT21_QUERY_KEYS.fromAsk) === '1';
  return { catNumber, askSats, fromAsk };
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
