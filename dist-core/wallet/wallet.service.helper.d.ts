import { LeatherAddressResponse, WalletInfo, WindowLike, XverseAddressResponse } from './wallet.service.types';
export declare const leatherOrdinalsAddressType = "p2tr";
export declare const leatherPaymentAddressType = "p2wpkh";
export declare function isXverseInstalled(win: WindowLike | undefined): boolean;
export declare function isLeatherInstalled(win: WindowLike | undefined): boolean;
/**
 * CAT-21 wallet detection. Per INTEGRATION-ORDPOOL-SDK.md in the
 * cat21-wallet repo:
 *
 *   - canonical slot: `window.Cat21Provider` ALWAYS present when
 *     CAT-21 wallet is installed; positive ID via `isCat21: true`
 *   - WBIP004 fallback: `window.btc_providers[]` carries a
 *     `{ id: 'Cat21Provider' }` entry, survives co-installation
 *
 * The wallet also politely backfills `window.LeatherProvider` (only
 * when real Leather is NOT installed); `isLeatherInstalled` filters
 * out `isCat21:true` providers so the picker never confuses the two.
 * We do NOT detect CAT-21 wallet via the Leather slot here — the
 * canonical Cat21Provider slot is always populated when the wallet
 * is present, so the LeatherProvider backfill is purely a courtesy
 * for dApps that key off `isLeather` and is not our discovery path.
 */
export declare function isCat21WalletInstalled(win: WindowLike | undefined): boolean;
/**
 * Resolve the active CAT-21 wallet provider object. Same discovery
 * path as `isCat21WalletInstalled`; returns `undefined` if no
 * provider with the `isCat21` marker is visible.
 *
 * Used by `cat21walletConnector` / `cat21walletSigner` to find the
 * `.request(...)` entry point.
 */
export declare function findCat21WalletProvider(win: WindowLike | undefined): {
    isCat21: true;
    request: (method: string, params?: unknown) => Promise<unknown>;
} | undefined;
export declare function isUnisatInstalled(win: WindowLike | undefined): boolean;
/**
 * Wizz exposes `window.wizz` AND the legacy `window.atom`
 * (formerly Atom Wallet). Detect either — both reference the same
 * provider via Proxy. Don't conflate with `window.atom` from
 * unrelated extensions because Wizz's binding sets the property
 * non-writable.
 */
export declare function isWizzInstalled(win: WindowLike | undefined): boolean;
/**
 * OKX is a multi-chain wallet — its BTC sub-provider lives at
 * `window.okxwallet.bitcoin`. We require the bitcoin sub-namespace
 * specifically; users with an OKX install but no BTC plugin
 * enabled won't get falsely listed as "OKX installed".
 */
export declare function isOkxInstalled(win: WindowLike | undefined): boolean;
/**
 * Phantom is multi-chain — require the `bitcoin` sub-provider
 * specifically. Detect-by-signature is the single rule: if
 * `window.phantom.bitcoin` is present we treat Phantom as
 * installed for BTC, if not we don't.
 *
 * On current Phantom desktop extension (v26.x confirmed
 * 2026-06), this returns false — the binary ships the BTC
 * sub-provider as dead code (btc.js exists but isn't registered
 * as a content script). So Phantom desktop currently never
 * shows up as installed in our picker. Phantom mobile in-app
 * browser is documented to expose this surface; if a user comes
 * through there, the same check returns true and the connector
 * works without code changes.
 */
export declare function isPhantomInstalled(win: WindowLike | undefined): boolean;
/**
 * Oyl injects a single top-level `window.oyl` provider — no multi-
 * chain wrapper, no sub-namespace.
 */
export declare function isOylInstalled(win: WindowLike | undefined): boolean;
/**
 * Alby exposes a top-level `window.alby` provider (Lightning + Nostr
 * focus). Also injects `window.webln` per the WebLN standard.
 * Detect either.
 */
export declare function isAlbyInstalled(win: WindowLike | undefined): boolean;
/**
 * Binance Web3 Wallet is multi-chain — require the `bitcoin`
 * sub-provider specifically (analogous to OKX / Phantom).
 *
 * Status note: developer docs (developers.binance.com/docs/binance
 * -w3w/bitcoin-provider) document a `window.binancew3w.bitcoin`
 * surface with requestAccounts / getPublicKey / signPsbt / etc.
 * The shipped v1.17.2 binary, however, injects only wallet /
 * ethereum / solana / tron / sui / tonconnect sub-providers — no
 * `.bitcoin` assignment. Detect returns false on current binaries.
 * If Binance ships the documented surface, this connector auto-
 * works without code changes.
 */
export declare function isBinanceInstalled(win: WindowLike | undefined): boolean;
/**
 * Narrow a raw sats-connect `getAddress` response into the SDK's
 * `WalletInfo` shape. Throws if either the Ordinals or Payment
 * address is absent — both are required for a CAT-21 mint flow,
 * so failing here surfaces a clearly broken wallet state instead
 * of a partial WalletInfo that would crash later in the signer.
 */
export declare function parseXverseAddressResponse(response: XverseAddressResponse): WalletInfo;
/**
 * Same idea for Leather: pluck the taproot (ordinals) and native-segwit
 * (payment) entries from the raw Leather response. Throws if either is
 * missing. The taproot pubkey is normalised to x-only via
 * toXOnlyPubkeyHex (Leather v6 returns it compressed).
 */
export declare function parseLeatherAddressResponse(response: LeatherAddressResponse): WalletInfo;
/**
 * Unisat exposes a single address that is used both for ordinals and
 * for payments (the wallet stores everything on one address). Wrap
 * its `{ address, publicKey }` into the SDK's `WalletInfo` shape.
 */
export declare function unisatBasicInfoToWalletInfo(address: string, publicKey: string): WalletInfo;
/**
 * Wizz inherits Unisat's single-address contract — same `{ address,
 * publicKey }` shape, populated into both ordinals + payment lanes.
 */
export declare function wizzBasicInfoToWalletInfo(address: string, publicKey: string): WalletInfo;
/**
 * OKX's BTC sub-provider returns one address at a time (whichever
 * type the user has active in their settings — Native SegWit /
 * Nested SegWit / Taproot / Legacy). Single-address contract,
 * same shape as Unisat / Wizz; both ordinals and payment lanes
 * populated from the one address.
 */
export declare function okxBasicInfoToWalletInfo(address: string, publicKey: string): WalletInfo;
/**
 * Binance's documented BTC sub-provider is Unisat-API-shaped:
 * single-address contract, both ordinals and payment lanes from
 * the same address. Per the docs, Binance also proxies
 * `window.unisat` (with API differences), confirming the family
 * resemblance. We do NOT proxy through `window.unisat` because
 * other wallets that overwrite that global would route to the
 * wrong provider; detect-by-`window.binancew3w.bitcoin` is the
 * specific check.
 */
export declare function binanceBasicInfoToWalletInfo(address: string, publicKey: string): WalletInfo;
/**
 * One entry in Phantom's `bitcoin.requestAccounts()` response. The
 * in-page provider strips the `bip122_` prefix from `addressType`
 * before returning (verified by disassembling btc.js v26.14.0,
 * see class Lh's #s helper at byte ~471900).
 */
export interface PhantomBtcAddress {
    address: string;
    publicKey: string;
    addressType: 'p2tr' | 'p2wpkh' | 'p2sh' | 'p2pkh';
    purpose: 'payment' | 'ordinals';
}
/** Oyl's getAddresses response: per-type address-and-pubkey objects. */
export interface OylAddressResponse {
    nativeSegwit?: {
        address: string;
        publicKey: string;
    };
    nestedSegwit?: {
        address: string;
        publicKey: string;
    };
    taproot?: {
        address: string;
        publicKey: string;
    };
}
/**
 * Oyl's `getAddresses()` returns a record keyed by address type
 * (nativeSegwit / nestedSegwit / taproot), each populated with
 * `{address, publicKey}`. Split into the SDK's lanes:
 *  - taproot → ordinalsAddress
 *  - nativeSegwit preferred for payment; fall back to nestedSegwit
 *    if nativeSegwit is absent
 *
 * Throws if either lane can't be filled.
 */
export declare function parseOylAddressResponse(r: OylAddressResponse): WalletInfo;
/**
 * Phantom's `bitcoin.requestAccounts()` is documented (and
 * confirmed by btc.js v26 disassembly) to return an array of
 * addresses, each tagged with `addressType` (p2tr/p2wpkh/p2sh/p2pkh)
 * and `purpose` ('payment' or 'ordinals'). Split into the SDK's
 * lanes by `purpose` (more reliable than addressType — Phantom's
 * "payment" address can be any non-taproot type per user setting).
 *
 * Throws if either lane is absent. The docs say both lanes come
 * back by default unless the caller passes `{purposes:[…]}` —
 * we don't, so we expect both.
 *
 * Pure-function unit test on a documented input shape. NOT a
 * contract pin against the live wallet (the live desktop wallet
 * currently doesn't expose this API at all, see isPhantomInstalled).
 */
export declare function parsePhantomAddressResponse(addresses: PhantomBtcAddress[]): WalletInfo;
//# sourceMappingURL=wallet.service.helper.d.ts.map