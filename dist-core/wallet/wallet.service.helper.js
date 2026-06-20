import { AddressPurpose } from 'sats-connect';
import { KnownOrdinalWalletType, } from './wallet.service.types';
// CodeReview @ Leather
// is this a correct    assumption? p2wpkh always for payments, p2tr always for ordinals?
export const leatherOrdinalsAddressType = 'p2tr'; // Taproot
export const leatherPaymentAddressType = 'p2wpkh'; // Native Segwit
export function isXverseInstalled(win) {
    return !!win?.XverseProviders;
}
export function isLeatherInstalled(win) {
    // `LeatherProvider` is the post-rebrand global; `HiroWalletProvider`
    // is the pre-rebrand one. Some users still have older versions.
    //
    // CAT-21 wallet — our own fork of Leather — politely fills the
    // `LeatherProvider` slot only when real Leather is NOT installed
    // (see INTEGRATION-ORDPOOL-SDK.md in the cat21-wallet repo). If
    // we see `isCat21: true` on the provider, this is CAT-21 wallet
    // backfilling Leather's slot, not actual Leather. Defer to the
    // cat21wallet connector so the picker shows the right entry.
    const lp = win?.LeatherProvider;
    if (lp?.isCat21)
        return false;
    return !!(lp ?? win?.HiroWalletProvider);
}
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
export function isCat21WalletInstalled(win) {
    const direct = win?.Cat21Provider;
    if (direct?.isCat21)
        return true;
    const list = win?.btc_providers;
    if (Array.isArray(list) && list.some(p => p?.id === 'Cat21Provider'))
        return true;
    return false;
}
/**
 * Resolve the active CAT-21 wallet provider object. Same discovery
 * path as `isCat21WalletInstalled`; returns `undefined` if no
 * provider with the `isCat21` marker is visible.
 *
 * Used by `cat21walletConnector` / `cat21walletSigner` to find the
 * `.request(...)` entry point.
 */
export function findCat21WalletProvider(win) {
    const direct = win?.Cat21Provider;
    if (direct?.isCat21 && typeof direct.request === 'function')
        return direct;
    // WBIP004 entry shape: the provider object itself is the second
    // element of the {id, name, provider} record (some wallets nest
    // the provider). Walk safely.
    const list = win?.btc_providers;
    if (Array.isArray(list)) {
        const entry = list.find(p => p?.id === 'Cat21Provider');
        if (entry?.provider?.isCat21 && typeof entry.provider.request === 'function') {
            return entry.provider;
        }
    }
    return undefined;
}
export function isUnisatInstalled(win) {
    return !!win?.unisat;
}
/**
 * Wizz exposes `window.wizz` AND the legacy `window.atom`
 * (formerly Atom Wallet). Detect either — both reference the same
 * provider via Proxy. Don't conflate with `window.atom` from
 * unrelated extensions because Wizz's binding sets the property
 * non-writable.
 */
export function isWizzInstalled(win) {
    return !!(win?.wizz ?? win?.atom);
}
/**
 * OKX is a multi-chain wallet — its BTC sub-provider lives at
 * `window.okxwallet.bitcoin`. We require the bitcoin sub-namespace
 * specifically; users with an OKX install but no BTC plugin
 * enabled won't get falsely listed as "OKX installed".
 */
export function isOkxInstalled(win) {
    const w = win?.okxwallet;
    return !!w?.bitcoin;
}
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
export function isPhantomInstalled(win) {
    const p = win?.phantom;
    return !!p?.bitcoin;
}
/**
 * Oyl injects a single top-level `window.oyl` provider — no multi-
 * chain wrapper, no sub-namespace.
 */
export function isOylInstalled(win) {
    return !!win?.oyl;
}
/**
 * Alby exposes a top-level `window.alby` provider (Lightning + Nostr
 * focus). Also injects `window.webln` per the WebLN standard.
 * Detect either.
 */
export function isAlbyInstalled(win) {
    return !!(win?.alby ?? win?.webln);
}
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
export function isBinanceInstalled(win) {
    const b = win?.binancew3w;
    return !!b?.bitcoin;
}
/**
 * Narrow a raw sats-connect `getAddress` response into the SDK's
 * `WalletInfo` shape. Throws if either the Ordinals or Payment
 * address is absent — both are required for a CAT-21 mint flow,
 * so failing here surfaces a clearly broken wallet state instead
 * of a partial WalletInfo that would crash later in the signer.
 */
export function parseXverseAddressResponse(response) {
    const ordinalsAddress = response.addresses.find(x => x.purpose === AddressPurpose.Ordinals);
    const paymentAddress = response.addresses.find(x => x.purpose === AddressPurpose.Payment);
    if (!ordinalsAddress || !paymentAddress) {
        throw new Error('Required address not found?!');
    }
    return {
        type: KnownOrdinalWalletType.xverse,
        ordinalsAddress: ordinalsAddress.address,
        ordinalsPublicKey: ordinalsAddress.publicKey,
        paymentAddress: paymentAddress.address,
        paymentPublicKey: paymentAddress.publicKey,
        signingSupported: true,
    };
}
/**
 * For BIP-86 taproot keys the SDK contract on
 * `WalletInfo.ordinalsPublicKey` is **x-only** (32 bytes, 64 hex
 * chars) — that's what's in the witness and what consumers want
 * for downstream signing/verification.
 *
 * Different wallets return the same key in different forms:
 *  - Xverse / sats-connect → x-only (64 hex)
 *  - Leather v6.x          → compressed (66 hex, leading 02 or 03)
 *  - Unisat                → reuses paymentPublicKey (single-address)
 *
 * Normalise here so the contract is consistent: if the input is the
 * compressed form, strip the parity byte; if it's already x-only,
 * pass through; otherwise (undefined / malformed) return as-is.
 */
function toXOnlyPubkeyHex(pubkey) {
    // Compressed sec256k1 pubkey = 1 parity byte + 32 x-coord bytes
    // = 33 bytes = 66 hex. Strip the leading 2 hex (1 byte) → 64 hex.
    if (/^0[23][0-9a-f]{64}$/i.test(pubkey))
        return pubkey.slice(2);
    return pubkey;
}
/**
 * Same idea for Leather: pluck the taproot (ordinals) and native-segwit
 * (payment) entries from the raw Leather response. Throws if either is
 * missing. The taproot pubkey is normalised to x-only via
 * toXOnlyPubkeyHex (Leather v6 returns it compressed).
 */
export function parseLeatherAddressResponse(response) {
    const addresses = response.result.addresses;
    const ordinalsAddress = addresses.find(x => x.type === leatherOrdinalsAddressType);
    const paymentAddress = addresses.find(x => x.type === leatherPaymentAddressType);
    if (!ordinalsAddress || !paymentAddress) {
        throw new Error('Required address not found?!');
    }
    return {
        type: KnownOrdinalWalletType.leather,
        ordinalsAddress: ordinalsAddress.address,
        ordinalsPublicKey: toXOnlyPubkeyHex(ordinalsAddress.publicKey),
        paymentAddress: paymentAddress.address,
        paymentPublicKey: paymentAddress.publicKey,
        signingSupported: true,
    };
}
/**
 * Unisat exposes a single address that is used both for ordinals and
 * for payments (the wallet stores everything on one address). Wrap
 * its `{ address, publicKey }` into the SDK's `WalletInfo` shape.
 */
export function unisatBasicInfoToWalletInfo(address, publicKey) {
    return {
        type: KnownOrdinalWalletType.unisat,
        ordinalsAddress: address,
        ordinalsPublicKey: publicKey,
        paymentAddress: address,
        paymentPublicKey: publicKey,
        signingSupported: true,
    };
}
/**
 * Wizz inherits Unisat's single-address contract — same `{ address,
 * publicKey }` shape, populated into both ordinals + payment lanes.
 */
export function wizzBasicInfoToWalletInfo(address, publicKey) {
    return {
        type: KnownOrdinalWalletType.wizz,
        ordinalsAddress: address,
        ordinalsPublicKey: publicKey,
        paymentAddress: address,
        paymentPublicKey: publicKey,
        signingSupported: true,
    };
}
/**
 * OKX's BTC sub-provider returns one address at a time (whichever
 * type the user has active in their settings — Native SegWit /
 * Nested SegWit / Taproot / Legacy). Single-address contract,
 * same shape as Unisat / Wizz; both ordinals and payment lanes
 * populated from the one address.
 */
export function okxBasicInfoToWalletInfo(address, publicKey) {
    return {
        type: KnownOrdinalWalletType.okx,
        ordinalsAddress: address,
        ordinalsPublicKey: publicKey,
        paymentAddress: address,
        paymentPublicKey: publicKey,
        signingSupported: true,
    };
}
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
export function binanceBasicInfoToWalletInfo(address, publicKey) {
    return {
        type: KnownOrdinalWalletType.binance,
        ordinalsAddress: address,
        ordinalsPublicKey: publicKey,
        paymentAddress: address,
        paymentPublicKey: publicKey,
        signingSupported: true,
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
export function parseOylAddressResponse(r) {
    const ordinals = r.taproot;
    const payment = r.nativeSegwit ?? r.nestedSegwit;
    if (!ordinals || !payment) {
        throw new Error('Required address not found?!');
    }
    return {
        type: KnownOrdinalWalletType.oyl,
        ordinalsAddress: ordinals.address,
        // Same x-only normalisation as Leather / Phantom.
        ordinalsPublicKey: toXOnlyPubkeyHex(ordinals.publicKey),
        paymentAddress: payment.address,
        paymentPublicKey: payment.publicKey,
        signingSupported: true,
    };
}
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
export function parsePhantomAddressResponse(addresses) {
    const ordinals = addresses.find(a => a.purpose === 'ordinals');
    const payment = addresses.find(a => a.purpose === 'payment');
    if (!ordinals || !payment) {
        throw new Error('Required address not found?!');
    }
    return {
        type: KnownOrdinalWalletType.phantom,
        ordinalsAddress: ordinals.address,
        // Taproot pubkey from Phantom may come as full sec256k1
        // compressed (66 hex). Reuse the same normalisation as Leather
        // so SDK consumers see x-only (64 hex) consistently.
        ordinalsPublicKey: toXOnlyPubkeyHex(ordinals.publicKey),
        paymentAddress: payment.address,
        paymentPublicKey: payment.publicKey,
        signingSupported: true,
    };
}
//# sourceMappingURL=wallet.service.helper.js.map