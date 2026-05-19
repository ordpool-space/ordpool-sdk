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
 * Same idea for Leather: pluck the taproot (ordinals) and native-segwit
 * (payment) entries from the raw Leather response. Throws if either is
 * missing.
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
    ordinalsPublicKey: ordinalsAddress.publicKey,
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
