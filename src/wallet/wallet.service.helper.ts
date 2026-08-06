import { bech32m } from '@scure/base';
import { AddressPurpose } from 'sats-connect';

import {
  KnownOrdinalWalletType,
  LeatherAddressResponse,
  LeatherBtcAddress,
  WalletInfo,
  WindowLike,
  XverseAddressResponse,
} from './wallet.service.types';

/**
 * Xverse's regtest getAddress bug: the wallet encodes the taproot
 * address with `tb` HRP (testnet), then string-swaps `tb` -> `bcrt` in
 * the response. The checksum stays computed against `tb`, so the
 * emitted `bcrt1p…` is unparseable — every bech32/bech32m decoder
 * rejects it with an "Invalid checksum" error, and every downstream
 * consumer that touches the address (fee simulator, PSBT builder,
 * broadcast) throws.
 *
 * When we see a `bcrt1p…` that fails bech32m decode, try re-encoding
 * the `tb`-prefixed variant with the same data words but the `bcrt`
 * HRP. If that succeeds, return the re-encoded address; every
 * downstream layer accepts it. Mainnet / testnet / signet paths
 * short-circuit and return the input unchanged.
 */
export function repairXverseRegtestTaproot(address: string): string {
  if (!address.startsWith('bcrt1p')) return address;
  try {
    bech32m.decode(address as `${string}1${string}`);
    return address;
  } catch {
    // Try the "same words under tb" interpretation.
    try {
      const tbCandidate = ('tb' + address.slice(4)) as `${string}1${string}`;
      const decoded = bech32m.decode(tbCandidate);
      return bech32m.encode('bcrt', decoded.words);
    } catch {
      return address;
    }
  }
}


// CodeReview @ Leather
// is this a correct    assumption? p2wpkh always for payments, p2tr always for ordinals?
export const leatherOrdinalsAddressType = 'p2tr';  // Taproot
export const leatherPaymentAddressType = 'p2wpkh'; // Native Segwit


export function isXverseInstalled(win: WindowLike | undefined): boolean {
  return !!win?.XverseProviders;
}

export function isLeatherInstalled(win: WindowLike | undefined): boolean {
  // `LeatherProvider` is the post-rebrand global; `HiroWalletProvider`
  // is the pre-rebrand one. Some users still have older versions.
  //
  // CAT-21 wallet — our own fork of Leather — politely fills the
  // `LeatherProvider` slot only when real Leather is NOT installed
  // (see INTEGRATION-ORDPOOL-SDK.md in the cat21-wallet repo). If
  // we see `isCat21: true` on the provider, this is CAT-21 wallet
  // backfilling Leather's slot, not actual Leather. Defer to the
  // cat21wallet connector so the picker shows the right entry.
  const lp = win?.LeatherProvider as { isCat21?: boolean } | undefined;
  if (lp?.isCat21) return false;
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
export function isCat21WalletInstalled(win: WindowLike | undefined): boolean {
  const direct = win?.Cat21Provider as { isCat21?: boolean } | undefined;
  if (direct?.isCat21) return true;
  const list = win?.btc_providers as { id?: string }[] | undefined;
  if (Array.isArray(list) && list.some(p => p?.id === 'Cat21Provider')) return true;
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
export function findCat21WalletProvider(win: WindowLike | undefined):
  | { isCat21: true; request: (method: string, params?: unknown) => Promise<unknown> }
  | undefined {
  type P = { isCat21?: boolean; request?: (m: string, p?: unknown) => Promise<unknown> };
  const direct = win?.Cat21Provider as P | undefined;
  if (direct?.isCat21 && typeof direct.request === 'function') return direct as never;
  // WBIP004 entry shape: the provider object itself is the second
  // element of the {id, name, provider} record (some wallets nest
  // the provider). Walk safely.
  const list = win?.btc_providers as Array<{ id?: string; provider?: P }> | undefined;
  if (Array.isArray(list)) {
    const entry = list.find(p => p?.id === 'Cat21Provider');
    if (entry?.provider?.isCat21 && typeof entry.provider.request === 'function') {
      return entry.provider as never;
    }
  }
  return undefined;
}

export function isUnisatInstalled(win: WindowLike | undefined): boolean {
  return !!win?.unisat;
}

/**
 * Wizz exposes `window.wizz` AND the legacy `window.atom`
 * (formerly Atom Wallet). Detect either — both reference the same
 * provider via Proxy. Don't conflate with `window.atom` from
 * unrelated extensions because Wizz's binding sets the property
 * non-writable.
 */
export function isWizzInstalled(win: WindowLike | undefined): boolean {
  return !!(win?.wizz ?? win?.atom);
}

/**
 * OKX is a multi-chain wallet — its BTC sub-provider lives at
 * `window.okxwallet.bitcoin`. We require the bitcoin sub-namespace
 * specifically; users with an OKX install but no BTC plugin
 * enabled won't get falsely listed as "OKX installed".
 */
export function isOkxInstalled(win: WindowLike | undefined): boolean {
  const w = win?.okxwallet as { bitcoin?: unknown } | undefined;
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
export function isPhantomInstalled(win: WindowLike | undefined): boolean {
  const p = win?.phantom as { bitcoin?: unknown } | undefined;
  return !!p?.bitcoin;
}

/**
 * Alby exposes a top-level `window.alby` provider (Lightning + Nostr
 * focus). Also injects `window.webln` per the WebLN standard.
 * Detect either.
 */
export function isAlbyInstalled(win: WindowLike | undefined): boolean {
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
export function isBinanceInstalled(win: WindowLike | undefined): boolean {
  const b = win?.binancew3w as { bitcoin?: unknown } | undefined;
  return !!b?.bitcoin;
}

/**
 * Narrow a raw sats-connect `getAddress` response into the SDK's
 * `WalletInfo` shape. Throws if either the Ordinals or Payment
 * address is absent — both are required for a CAT-21 mint flow,
 * so failing here surfaces a clearly broken wallet state instead
 * of a partial WalletInfo that would crash later in the signer.
 */
export function parseXverseAddressResponse(response: XverseAddressResponse): WalletInfo {

  const ordinalsAddress = response.addresses.find(x => x.purpose === AddressPurpose.Ordinals);
  const paymentAddress  = response.addresses.find(x => x.purpose === AddressPurpose.Payment);

  if (!ordinalsAddress || !paymentAddress) {
    throw new Error('Required address not found?!');
  }

  return {
    type: KnownOrdinalWalletType.xverse,
    ordinalsAddress:   repairXverseRegtestTaproot(ordinalsAddress.address),
    ordinalsPublicKey: ordinalsAddress.publicKey,
    paymentAddress:    paymentAddress.address,
    paymentPublicKey:  paymentAddress.publicKey,
    signingSupported:  true,
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
function toXOnlyPubkeyHex(pubkey: string): string {
  // Compressed sec256k1 pubkey = 1 parity byte + 32 x-coord bytes
  // = 33 bytes = 66 hex. Strip the leading 2 hex (1 byte) → 64 hex.
  if (/^0[23][0-9a-f]{64}$/i.test(pubkey)) return pubkey.slice(2);
  return pubkey;
}

/**
 * Same idea for Leather: pluck the taproot (ordinals) and native-segwit
 * (payment) entries from the raw Leather response. Throws if either is
 * missing. The taproot pubkey is normalised to x-only via
 * toXOnlyPubkeyHex (Leather v6 returns it compressed).
 */
export function parseLeatherAddressResponse(response: LeatherAddressResponse): WalletInfo {

  const addresses = response.result.addresses as LeatherBtcAddress[];
  const ordinalsAddress = addresses.find(x => x.type === leatherOrdinalsAddressType);
  const paymentAddress  = addresses.find(x => x.type === leatherPaymentAddressType);

  if (!ordinalsAddress || !paymentAddress) {
    throw new Error('Required address not found?!');
  }

  return {
    type: KnownOrdinalWalletType.leather,
    ordinalsAddress:   ordinalsAddress.address,
    ordinalsPublicKey: toXOnlyPubkeyHex(ordinalsAddress.publicKey),
    paymentAddress:    paymentAddress.address,
    paymentPublicKey:  paymentAddress.publicKey,
    signingSupported:  true,
  };
}

/**
 * Unisat exposes a single address that is used both for ordinals and
 * for payments (the wallet stores everything on one address). Wrap
 * its `{ address, publicKey }` into the SDK's `WalletInfo` shape.
 */
export function unisatBasicInfoToWalletInfo(address: string, publicKey: string): WalletInfo {
  return {
    type: KnownOrdinalWalletType.unisat,
    ordinalsAddress:   address,
    ordinalsPublicKey: publicKey,
    paymentAddress:    address,
    paymentPublicKey:  publicKey,
    signingSupported:  true,
  };
}

/**
 * Wizz inherits Unisat's single-address contract — same `{ address,
 * publicKey }` shape, populated into both ordinals + payment lanes.
 */
export function wizzBasicInfoToWalletInfo(address: string, publicKey: string): WalletInfo {
  return {
    type: KnownOrdinalWalletType.wizz,
    ordinalsAddress:   address,
    ordinalsPublicKey: publicKey,
    paymentAddress:    address,
    paymentPublicKey:  publicKey,
    signingSupported:  true,
  };
}

/**
 * OKX's BTC sub-provider returns one address at a time (whichever
 * type the user has active in their settings — Native SegWit /
 * Nested SegWit / Taproot / Legacy). Single-address contract,
 * same shape as Unisat / Wizz; both ordinals and payment lanes
 * populated from the one address.
 */
export function okxBasicInfoToWalletInfo(address: string, publicKey: string): WalletInfo {
  return {
    type: KnownOrdinalWalletType.okx,
    ordinalsAddress:   address,
    ordinalsPublicKey: publicKey,
    paymentAddress:    address,
    paymentPublicKey:  publicKey,
    signingSupported:  true,
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
export function binanceBasicInfoToWalletInfo(address: string, publicKey: string): WalletInfo {
  return {
    type: KnownOrdinalWalletType.binance,
    ordinalsAddress:   address,
    ordinalsPublicKey: publicKey,
    paymentAddress:    address,
    paymentPublicKey:  publicKey,
    signingSupported:  true,
  };
}

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
export function parsePhantomAddressResponse(addresses: PhantomBtcAddress[]): WalletInfo {
  const ordinals = addresses.find(a => a.purpose === 'ordinals');
  const payment = addresses.find(a => a.purpose === 'payment');
  if (!ordinals || !payment) {
    throw new Error('Required address not found?!');
  }
  return {
    type: KnownOrdinalWalletType.phantom,
    ordinalsAddress:   ordinals.address,
    // Taproot pubkey from Phantom may come as full sec256k1
    // compressed (66 hex). Reuse the same normalisation as Leather
    // so SDK consumers see x-only (64 hex) consistently.
    ordinalsPublicKey: toXOnlyPubkeyHex(ordinals.publicKey),
    paymentAddress:    payment.address,
    paymentPublicKey:  payment.publicKey,
    signingSupported:  true,
  };
}
