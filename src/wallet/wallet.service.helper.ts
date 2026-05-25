import { AddressPurpose } from 'sats-connect';

import {
  KnownOrdinalWalletType,
  LeatherAddressResponse,
  LeatherBtcAddress,
  WalletInfo,
  WindowLike,
  XverseAddressResponse,
} from './wallet.service.types';


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
  return !!(win?.LeatherProvider ?? win?.HiroWalletProvider);
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
    ordinalsAddress:   ordinalsAddress.address,
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
