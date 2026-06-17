import * as btc from '@scure/btc-signer';

import { getAddressFormat } from './address-format';

/**
 * Per-wallet input-script construction.
 *
 * Every wallet picks its own family of payment-address formats. The
 * SDK normalises these into a single scure `P2Ret` (or `P2TROut`)
 * shape that the Layer-1 builders can consume. These helpers live in
 * `cat21-script/` because they're useful for ANY cat-touching flow
 * (mint, transfer, offer) — not just mint.
 */

/**
 * Creates an input script for the Xverse wallet.
 *
 * Xverse v1 used P2SH-wrapped SegWit (Nested SegWit, `3…` /
 * `2…` testnet) as the only payment format. Xverse v2+ defaults
 * to native SegWit P2WPKH (`bc1q…` / `bcrt1q…`) and exposes
 * nested-SegWit as a secondary option. Dispatch on the actual
 * address format so both flavours work — Unisat already does
 * the same.
 */
export function createInputScriptForXverse(paymentAddress: string, paymentPublicKey: Uint8Array, network: typeof btc.NETWORK): btc.P2Ret {
  const addressFormat = getAddressFormat(paymentAddress);
  switch (addressFormat) {
    case 'P2WPKH':
      return btc.p2wpkh(paymentPublicKey, network);
    case 'P2SH???': {
      const p2wpkhForP2sh = btc.p2wpkh(paymentPublicKey, network);
      return btc.p2sh(p2wpkhForP2sh, network);
    }
    default:
      throw new Error(`Xverse: unsupported payment address format ${addressFormat} for ${paymentAddress}`);
  }
}

/**
 * Creates an input script for the Leather wallet.
 *
 * The payment address for Leather is always a P2WPKH / Native SegWit
 * (`bc1q…`). CAT-21 wallet is forked from Leather and inherits the
 * same shape.
 *
 * see https://leather.gitbook.io/developers/bitcoin/sign-transactions/partially-signed-bitcoin-transactions-psbts
 */
export function createInputScriptForLeather(paymentPublicKey: Uint8Array, network: typeof btc.NETWORK): btc.P2Ret {
  return btc.p2wpkh(paymentPublicKey, network);
}

/**
 * Creates an input script for the Unisat wallet, detecting and handling various address types.
 *
 * The assumption is that we _ONLY_ have these address formats:
 * - Legacy (P2PKH)
 * - Nested Segwit (P2SH-P2WPKH) --> identified as P2SH???
 * - Native Seqwit (P2WPKH)
 * - Taproot (P2TR)
 *
 * see https://docs.unisat.io/unisat-wallet/address-type
 *
 * @returns An object containing the necessary script and redeemScript for the transaction input.
 */
export function createInputScriptForUnisat(paymentAddress: string, paymentPublicKey: Uint8Array, network: typeof btc.NETWORK): btc.P2Ret {
  const addressFormat = getAddressFormat(paymentAddress);

  switch (addressFormat) {
    // "Legacy" Pay-to-Public-Key-Hash
    case 'P2PKH': {
      // Legacy addresses do not use witness data
      return btc.p2pkh(paymentPublicKey, network);
    }
    // P2SH could be anything, but for Unisat we know that it is Nested Segwit
    case 'P2SH???': {
      const p2wpkhForP2sh = btc.p2wpkh(paymentPublicKey, network);
      return btc.p2sh(p2wpkhForP2sh, network);
    }
    // Native Seqwit
    case 'P2WPKH': {
      return btc.p2wpkh(paymentPublicKey, network);
    }
    // Taproot
    case 'P2TR': {
      // Key-spend -- the simpler setup. For script-spend see
      // https://github.com/paulmillr/scure-btc-signer/issues/51
      return btc.p2tr(paymentPublicKey, undefined, network, true);
    }
    default:
      throw new Error('Unexpected address format encountered.');
  }
}
