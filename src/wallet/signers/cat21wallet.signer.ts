import * as btc from '@scure/btc-signer';
import { Observable } from 'rxjs';

import { toLeatherNetworkString } from '../../network.js';
import { findCat21WalletProvider } from '../wallet.service.helper.js';
import {
  KnownOrdinalWalletType,
  SignMessageArgs,
  SignMessageResult,
  WalletSigner,
  WindowLike,
} from '../wallet.service.types.js';
import { makeLeatherFamilySigner } from './leather-family-signer.helper.js';
import { wrapSignMessage } from './wrap-sign-message.js';


interface Cat21WalletPSBTResponse {
  result: { hex: string };
}

interface Cat21WalletSignPsbtParams {
  hex: string;
  allowedSighash: number[];
  /**
   * Which input indexes to sign. cat21-wallet accepts either a single number
   * or an array (see its `sign-psbt.ts` → ensureArray). Passing the array lets
   * the wallet sign multiple inputs in a SINGLE approval popup, essential for
   * the transfer flow (cat input at ordinalsAddress + funding input at
   * paymentAddress), so this signer uses `multiInput: 'array'`.
   */
  signAtIndex: number | number[];
  network: 'mainnet' | 'testnet' | 'signet' | 'sbtcDevenv' | 'devnet' | 'regtest';
  broadcast: false;
}

interface Cat21WalletSignMessageResponse {
  result: { signature: string };
}

function provider() {
  const found = findCat21WalletProvider(window as unknown as WindowLike);
  if (!found) {
    throw new Error('CAT-21 wallet provider not present (window.Cat21Provider undefined or missing isCat21:true marker)');
  }
  return found;
}

/**
 * Sign the given input index(es). CAT-21 wallet is forked from Leather and
 * inherits its signPsbt JSON-RPC shape verbatim; the sighash whitelist is
 * `[SigHash.ALL]`, same as Leather and the rest of the cat-flow path. Network
 * mapping uses Leather's strings even though cat21-wallet is mainnet-only (its
 * internal validators still expect the string in the envelope).
 */
function callCat21WalletSignPsbt(
  psbtHex: string,
  signAtIndex: number | number[],
  network: Cat21WalletSignPsbtParams['network'],
): Promise<string> {
  const params: Cat21WalletSignPsbtParams = {
    hex: psbtHex,
    allowedSighash: [btc.SigHash.ALL],
    signAtIndex,
    network,
    broadcast: false,
  };
  return (provider().request('signPsbt', params) as Promise<Cat21WalletPSBTResponse>)
    .then((resp) => resp.result.hex);
}

/**
 * BIP-322 message signing via `window.Cat21Provider.request('signMessage', ...)`.
 * Inherits Leather's shape verbatim. The caller passes the final human-visible
 * bytes (the wallet renders them in the approval popup); `paymentType: 'p2tr'`
 * forces the ordinals key, under which the BIP-322 ownership proof must sign.
 * `result.signature` is base64 BIP-322 witness bytes (raw or wrapped-witness;
 * verifyListingSignature accepts both).
 */
function callCat21WalletSignMessage(message: string): Promise<string> {
  return (provider().request('signMessage', { message, paymentType: 'p2tr' }) as Promise<Cat21WalletSignMessageResponse>)
    .then((resp) => resp.result.signature);
}


/**
 * CAT-21 wallet — `window.Cat21Provider.request('signPsbt', …)`. A Leather fork
 * that signs and hands the bytes back; the SDK broadcasts. It signs every listed
 * index in ONE approval popup (`multiInput: 'array'`).
 */
export const cat21walletSigner: WalletSigner = makeLeatherFamilySigner({
  walletType: KnownOrdinalWalletType.cat21wallet,
  signPsbt: (psbtHex, signAtIndex, network) =>
    callCat21WalletSignPsbt(psbtHex, signAtIndex, toLeatherNetworkString(network)),
  multiInput: 'array',
  signMessage: (input: SignMessageArgs): Observable<SignMessageResult> =>
    wrapSignMessage(() => callCat21WalletSignMessage(input.message)),
});
