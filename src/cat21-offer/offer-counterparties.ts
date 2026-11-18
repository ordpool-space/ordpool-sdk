/**
 * The parties a buy-offer pays or trades with, as the agent-policy allowlist
 * (`AgentActionContext.counterpartyAddresses`) needs them.
 */
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network.js';

/**
 * The address a scriptPubKey pays. A script that is no address yields
 * `script:<hex>`, which no allowlist entry can equal, so such a party is
 * denied under an allowlist instead of dropped from the check.
 */
export function counterpartyOfScript(script: Uint8Array, network: Network): string {
  try {
    return btc.Address(toScureNetwork(network)).encode(btc.OutScript.decode(script));
  } catch {
    return `script:${hex.encode(script)}`;
  }
}

/**
 * The BUYER side of a buy-offer (create-offer): who the agent trades with is
 * the seller, reached at two addresses. The seller's payment address receives
 * the price plus the cat's postage, and the cat UTXO's own address is where
 * the cat being bought sits. Both are listed, once each.
 */
export function createOfferCounterparties(args: {
  sellerPaymentAddress: string;
  targetCatScriptPubKey: Uint8Array;
  network: Network;
}): string[] {
  const owner = counterpartyOfScript(args.targetCatScriptPubKey, args.network);
  return [...new Set([args.sellerPaymentAddress, owner])];
}
