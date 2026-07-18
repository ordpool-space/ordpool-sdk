/**
 * Branded Bitcoin address types — compile-time separation of the two
 * categories that keep getting confused in code review + at run time:
 *
 *   - `OrdinalsAddress` — the address a wallet's ordinals-key signs.
 *     Cats, inscriptions, runes, rare sats live here. Almost always
 *     a P2TR (taproot) address in modern wallets. Every on-chain
 *     "who owns this cat / inscription" lookup returns this type;
 *     ord's `/output/*` / `/cat/*` / `/inscription/*` all speak in
 *     this context.
 *   - `PaymentAddress` — the address a wallet's payment-key signs.
 *     BTC for fees and change lives here. Usually P2WPKH (bech32) or
 *     P2SH-P2WPKH; on single-address wallets (Unisat, xpub-only),
 *     structurally equal to `OrdinalsAddress`.
 *
 * The types share the underlying representation (`string`) so a
 * branded value flows freely into any `string` parameter — nothing
 * you already have breaks. The protection kicks in when a callee
 * types its parameter as one of the branded types: passing the
 * wrong brand fails to compile.
 *
 * Consumers that pass a bare `string` (URL params, textbox input,
 * on-chain lookup responses) must go through a constructor
 * (`toPaymentAddress` / `toOrdinalsAddress`). The constructor
 * validates the raw bytes AND forces the caller to name the type
 * explicitly — which is the friction that prevented the 2026-07-18
 * "auto-fill payment address from cat's on-chain owner" bug. See
 * the SDK CLAUDE.md HARD RULE "Never derive a payment address from
 * an on-chain lookup" for the full incident writeup.
 *
 * The typical trigger for those bugs is prose that talks about "the
 * seller's address" as if that were a single concept. The two are
 * different signing surfaces on the same wallet; the type system
 * refuses to conflate them.
 */

declare const OrdinalsBrand: unique symbol;
declare const PaymentBrand: unique symbol;

/**
 * A Bitcoin address that belongs to a wallet's ORDINALS-signing key.
 * Anything a cat, inscription, or rune lands on; the address ord
 * returns on ownership lookups.
 */
export type OrdinalsAddress = string & { readonly [OrdinalsBrand]: true };

/**
 * A Bitcoin address that belongs to a wallet's PAYMENT-signing key.
 * Anything that receives ordinary BTC — offer payments, change
 * outputs, fee-paying UTXOs.
 */
export type PaymentAddress = string & { readonly [PaymentBrand]: true };

/**
 * Address format check shared by both constructors. Accepts:
 *   - bech32 / bech32m (P2WPKH, P2WSH, P2TR — mainnet / testnet /
 *     regtest HRPs `bc`, `tb`, `bcrt`);
 *   - legacy base58 (P2PKH `1…`, P2SH `3…`, testnet `m…`/`n…`/`2…`).
 *
 * This is a shape check, not a full checksum decode. The caller's
 * signing / broadcast layer runs the full `@scure/btc-signer`
 * `Address(network).decode` before touching the wire. Runtime
 * validation belongs at the boundary; the type-brand is a
 * compile-time hint about which SIGNING CONTEXT the address
 * belongs to, not a proof of on-chain validity.
 */
const ADDRESS_SHAPE_RE =
  /^(bc|tb|bcrt)1[0-9a-z]{25,87}$|^[13mn2][a-km-zA-HJ-NP-Z1-9]{25,60}$/;

function assertShape(s: string, context: 'OrdinalsAddress' | 'PaymentAddress'): void {
  if (typeof s !== 'string' || !ADDRESS_SHAPE_RE.test(s)) {
    throw new Error(`${context} must be a valid Bitcoin address; got ${JSON.stringify(s)}`);
  }
}

/**
 * Cast a raw string into an `OrdinalsAddress`. Use at the boundary
 * where the wallet or ord API returns an owner address — this
 * documents "we treated this string as ordinals-context, and the
 * downstream type system will enforce it stays there".
 */
export function toOrdinalsAddress(s: string): OrdinalsAddress {
  assertShape(s, 'OrdinalsAddress');
  return s as OrdinalsAddress;
}

/**
 * Cast a raw string into a `PaymentAddress`. Use at the boundary
 * where the wallet returns its payment address, OR where the seller's
 * payment address arrives from a trusted-to-be-payment source (the
 * URL's `payTo=` param — see `parseAskQueryParams` — or the seller's
 * connected wallet at sell-modal time).
 *
 * **Never** call this on a value that came from an on-chain owner
 * lookup — that's the ordinals address in ordinal-theory-tracked
 * contexts. The compiler can't stop you (both types are `string`
 * subtypes), but the SDK HARD RULE "Never derive a payment address
 * from an on-chain lookup" spells out why the audit will reject it.
 */
export function toPaymentAddress(s: string): PaymentAddress {
  assertShape(s, 'PaymentAddress');
  return s as PaymentAddress;
}

/**
 * Escape hatch for the rare code that legitimately does not care
 * about the signing context — e.g. rendering an address in a
 * text-only display, hashing for equality, logging. Prefer the
 * branded types wherever the address will be USED (as an input to a
 * PSBT builder, a validator, a signer). Only reach for this when
 * you need a raw string for a truly context-free operation.
 */
export function eitherAsString(addr: OrdinalsAddress | PaymentAddress | string): string {
  return addr as string;
}
