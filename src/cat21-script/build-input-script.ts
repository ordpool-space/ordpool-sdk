import * as btc from '@scure/btc-signer';

import { getAddressFormat, toXOnly } from './address-format';
import { getDummyKeypair } from '../cat21-fee/dummy-keypair';

/**
 * Universal input-script builder.
 *
 * Dispatches PURELY on the address format observed in
 * `paymentAddress`. No wallet-name switch. Every wallet — including
 * wallets the SDK doesn't know about by name — produces a correct
 * input shape as long as it returns a payment address + pubkey
 * the caller forwards.
 *
 * Replaces the per-wallet `createInputScriptFor{Leather,Xverse,Unisat}`
 * functions, which were really just address-format dispatchers
 * dressed as wallet-specific code. The only thing wallet identity
 * ever contributed was "is the pubkey already x-only for taproot?"
 * — which we now answer at runtime from the pubkey's length (32 vs
 * 33 bytes).
 *
 * Pure function. No I/O, no Angular. Used by every CAT-21 Layer-2
 * input adapter (mint, transfer, offer).
 */
export interface BuildInputScriptArgs {
  paymentAddress: string;
  /**
   * Payment public key from the wallet's `getAddresses`-equivalent
   * call. ALL wallets agree on:
   *   - 33-byte compressed for non-taproot inputs
   *   - 32-byte x-only OR 33-byte compressed for taproot (the SDK
   *     normalises by stripping the parity byte when 33 bytes are
   *     supplied; the wallet handed us either form depending on its
   *     convention).
   */
  paymentPublicKey: Uint8Array;
  /**
   * Simulation mode: swap the supplied pubkey for the SDK's
   * well-known dummy keypair so vsize is observable during the
   * two-pass fee simulation without exposing the user's key.
   * NEVER use the result of a simulation build for real signing.
   */
  isSimulation: boolean;
  network: typeof btc.NETWORK;
}

export interface BuildInputScriptResult {
  /**
   * Scure script object — `P2Ret` for everything except Taproot,
   * `P2TROut` for Taproot. Both expose `script` (the scriptPubKey)
   * and Taproot additionally exposes the script-path tweaks the
   * adapter merges into the input.
   */
  scriptData: btc.P2Ret | btc.P2TROut;
  /**
   * Only set for Taproot — the x-only internal key the adapter
   * attaches to the input so a key-path signer produces a valid
   * Schnorr signature. `undefined` for every other address format.
   */
  tapInternalKey: Uint8Array | undefined;
}

/**
 * Build the scure script for a payment input.
 *
 * The decision is:
 *   - Look at `paymentAddress` → derive the script type.
 *   - For Taproot: ensure the pubkey is x-only (32 bytes) — strip
 *     the parity byte if a 33-byte compressed key was supplied.
 *   - If `isSimulation`, swap in the dummy keypair before any of
 *     the above (Taproot simulation uses the schnorr-derived x-only
 *     dummy; non-taproot uses the compressed dummy).
 *
 * That's the whole algorithm. No per-wallet branching, anywhere.
 */
export function buildInputScript(args: BuildInputScriptArgs): BuildInputScriptResult {
  const format = getAddressFormat(args.paymentAddress);

  // Simulation: swap the real pubkey for the SDK's dummy. The
  // schnorr-derived `xOnlyDummyPublicKey` matters for Taproot
  // because it has the y-coordinate parity normalised — a plain
  // `dummyPublicKey.slice(1, 33)` would not.
  let pubkey = args.paymentPublicKey;
  if (args.isSimulation) {
    const dummy = getDummyKeypair(args.network);
    pubkey = format === 'P2TR' ? dummy.xOnlyDummyPublicKey : dummy.dummyPublicKey;
  }

  switch (format) {
    case 'P2PKH':
      return { scriptData: btc.p2pkh(pubkey, args.network), tapInternalKey: undefined };

    case 'P2SH???':
      // Treat ANY P2SH address as P2SH-wrapped Segwit (P2SH-P2WPKH).
      // This is the same assumption Xverse and Unisat made for years
      // — there's no on-chain way to distinguish P2SH-P2WPKH from
      // other P2SH variants from the address alone, and every wallet
      // that exposes a P2SH payment address in this SDK uses Nested
      // SegWit. P2SH-multisig or other P2SH variants would need a
      // separate code path; none of the supported wallets ship them.
      return {
        scriptData: btc.p2sh(btc.p2wpkh(pubkey, args.network), args.network),
        tapInternalKey: undefined,
      };

    case 'P2WPKH':
      return { scriptData: btc.p2wpkh(pubkey, args.network), tapInternalKey: undefined };

    case 'P2TR': {
      // Normalise to 32-byte x-only. Wallets that already hand us 32
      // bytes get a no-op; wallets that send 33-byte compressed get
      // the parity byte stripped.
      const xOnly = pubkey.length === 32 ? pubkey : toXOnly(pubkey);
      return {
        scriptData: btc.p2tr(xOnly, undefined, args.network, true),
        tapInternalKey: xOnly,
      };
    }
  }
}
