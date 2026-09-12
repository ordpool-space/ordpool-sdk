import { hex } from '@scure/base';

import { getAddressFormat } from '../cat21-script/address-format';
import { buildInputScript } from '../cat21-script/build-input-script';
import { Network, toScureNetwork } from '../network';
import { failInscribe, type InscribeErrorCode } from './inscribe-errors';

/** The two byte-level fields a P2TR input the wallet can sign needs. */
export interface OwnedTaprootInput {
  /** The coin's P2TR output script, built from the TWEAKED output key. */
  scriptPubKey: Uint8Array;
  /** The UNTWEAKED x-only internal key, which is what a key-path signer signs with. */
  tapInternalKey: Uint8Array;
}

/**
 * Derive the script and internal key for a P2TR coin the connected wallet owns,
 * and prove it owns it.
 *
 * Swapping the tweaked output key for the untweaked internal key builds an
 * input that looks right and cannot be spent, so the derivation runs through
 * the same `buildInputScript` the rest of the SDK signs with, and the address
 * it produces is checked against the address the coin actually sits at. A key
 * that does not reproduce that address is the wrong key, and says so rather
 * than building silently.
 *
 * The caller passes the error codes, because "this coin is not yours" means
 * something different for a sat source than for an inscription's parent.
 */
export function deriveOwnedTaprootInput(
  address: string,
  ordinalsPublicKey: string | Uint8Array,
  network: Network,
  codes: { notTaproot: InscribeErrorCode; notOwned: InscribeErrorCode },
  notOwnedUserMessage: string,
): OwnedTaprootInput {
  if (getAddressFormat(address) !== 'P2TR') {
    failInscribe(codes.notTaproot,
      `expected a P2TR output; ${address} is not one`,
      'That coin is not a Taproot coin, so it cannot be used here.',
      { address });
  }
  const pubkey = typeof ordinalsPublicKey === 'string' ? hex.decode(ordinalsPublicKey) : ordinalsPublicKey;
  const { scriptData, tapInternalKey } = buildInputScript({
    paymentAddress: address,
    paymentPublicKey: pubkey,
    isSimulation: false,
    network: toScureNetwork(network),
  });
  if (tapInternalKey === undefined) {
    throw new Error('buildInputScript returned no tapInternalKey for a P2TR address');
  }
  if (scriptData.address !== address) {
    failInscribe(codes.notOwned,
      `the ordinals public key derives ${scriptData.address}, not ${address}, so it does not own this coin`,
      notOwnedUserMessage,
      { address, derivedAddress: scriptData.address });
  }
  return { scriptPubKey: scriptData.script, tapInternalKey };
}
