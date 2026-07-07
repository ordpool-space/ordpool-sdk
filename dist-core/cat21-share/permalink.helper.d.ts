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
export declare const CAT21_QUERY_KEYS: {
    /** `/cat/N?ask=<sats>` — seller advertises a price. */
    readonly ask: "ask";
    /** `?catNumber=<n>` — pre-fill for make-offer or transfer. */
    readonly catNumber: "catNumber";
    /** `?askPrice=<sats>` — buyer-side landing knows what the seller asked. */
    readonly askPrice: "askPrice";
    /** `?fromAsk=1` — buyer-side banner "responding to an ask". */
    readonly fromAsk: "fromAsk";
    /** `?offer=<base64>` — the buyer-signed PSBT bytes to hand the seller. */
    readonly offer: "offer";
    /** `?catTxid=<64-hex>` — one half of the cat outpoint (matches offer input 0). */
    readonly catTxid: "catTxid";
    /** `?catVout=<uint>` — other half of the cat outpoint. */
    readonly catVout: "catVout";
};
/** Cat outpoint carried in URLs (accept-offer, transfer). */
export interface CatOutpoint {
    /** Lowercase 64-hex txid. */
    txid: string;
    /** Zero-based vout index. */
    vout: number;
}
export interface AskQueryArgs {
    /** Price the seller is asking, in sats. Must be a positive integer. */
    askSats: number;
}
/**
 * Build the query params for an ask permalink. Consumer concatenates
 * with its own detail path, e.g. `${origin}/cat/${n}?${new URLSearchParams(query)}`.
 */
export declare function buildAskQueryParams(args: AskQueryArgs): Record<string, string>;
/**
 * Parse an ask-query. Returns the ask value in sats when the `ask`
 * param is a positive integer; `null` when missing or malformed
 * (defence-in-depth against tampered links).
 */
export declare function parseAskQueryParams(query: URLSearchParams | Record<string, string | null>): number | null;
export interface BuyOfferQueryArgs {
    /** Cat the buyer wants to bid on. */
    catNumber: number;
    /** Ask price from the seller's link, in sats. Optional — a plain
     *  "make me an offer" link is fine too. */
    askSats?: number;
}
export declare function buildBuyOfferQueryParams(args: BuyOfferQueryArgs): Record<string, string>;
export declare function parseBuyOfferQueryParams(query: URLSearchParams | Record<string, string | null>): {
    catNumber: number | null;
    askSats: number | null;
    fromAsk: boolean;
};
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
export declare function buildAcceptOfferQueryParams(args: AcceptOfferQueryArgs): Record<string, string>;
export declare function parseAcceptOfferQueryParams(query: URLSearchParams | Record<string, string | null>): {
    offerBase64: string | null;
    catOutpoint: CatOutpoint | null;
    bundleComplete: boolean;
};
export interface TransferQueryArgs {
    /** Cat the sender is transferring. */
    catNumber: number;
    /** Cat outpoint. Optional — the transfer page falls back to picker if omitted. */
    catOutpoint?: CatOutpoint;
}
export declare function buildTransferQueryParams(args: TransferQueryArgs): Record<string, string>;
export declare function parseTransferQueryParams(query: URLSearchParams | Record<string, string | null>): {
    catNumber: number | null;
    catOutpoint: CatOutpoint | null;
};
//# sourceMappingURL=permalink.helper.d.ts.map