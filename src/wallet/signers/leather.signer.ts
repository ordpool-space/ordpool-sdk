import * as btc from '@scure/btc-signer';
import { Observable } from 'rxjs';

import { toLeatherNetworkString } from '../../network.js';
import { toWireNetworkFor } from '../network-address-shim.js';
import {
  KnownOrdinalWalletType,
  SignMessageArgs,
  SignMessageResult,
  WalletSigner,
} from '../wallet.service.types.js';
import { makeLeatherFamilySigner } from './leather-family-signer.helper.js';
import { wrapSignMessage } from './wrap-sign-message.js';


interface LeatherPSBTBroadcastResponse {
  result: { hex: string };
}

interface LeatherSignPsbtRequestParams {
  hex: string;
  allowedSighash: number[];
  signAtIndex: number;
  network: 'mainnet' | 'testnet' | 'signet' | 'sbtcDevenv' | 'devnet' | 'regtest';
  broadcast: false;
}

interface LeatherSignMessageParams {
  message: string;
  /**
   * Which key signs. `'p2tr'` selects the taproot / ordinals key, the one
   * BIP-322 for CAT-21 listings needs (cats live on the ordinals key per
   * ordinal theory).
   */
  paymentType: 'p2tr' | 'p2wpkh';
}

interface LeatherSignMessageResponse {
  result: {
    signature: string; // base64 BIP-322 witness
    address: string;   // returned for confirmation; caller may cross-check
  };
}

interface LeatherRpcWindow {
  LeatherProvider: {
    request(method: 'signPsbt', params: LeatherSignPsbtRequestParams): Promise<LeatherPSBTBroadcastResponse>;
    request(method: 'signMessage', params: LeatherSignMessageParams): Promise<LeatherSignMessageResponse>;
  };
}


/**
 * Sign one input index. Leather's signPsbt takes a single `signAtIndex`, so
 * multi-input flows chain one call per index (`multiInput: 'chain'`).
 *
 * Namespace: `window.LeatherProvider`, NOT the historical `window.btc` (the old
 * Hiro namespace other extensions aggressively overwrote, which routed our code
 * to the wrong wallet for users with several extensions installed).
 */
function callLeatherSignPsbt(
  psbtHex: string,
  signAtIndex: number,
  network: LeatherSignPsbtRequestParams['network'],
): Promise<string> {
  const win = window as unknown as LeatherRpcWindow;
  const params: LeatherSignPsbtRequestParams = {
    hex: psbtHex,
    allowedSighash: [btc.SigHash.ALL],
    signAtIndex,
    network,
    broadcast: false,
  };
  return win.LeatherProvider.request('signPsbt', params).then((resp) => resp.result.hex);
}

/**
 * BIP-322 message signing via `window.LeatherProvider.request('signMessage', ...)`.
 * `paymentType: 'p2tr'` forces the ordinals key. The response's
 * `result.signature` is already base64-encoded BIP-322 witness bytes.
 */
function callLeatherSignMessage(message: string): Promise<string> {
  const win = window as unknown as LeatherRpcWindow;
  return win.LeatherProvider.request('signMessage', { message, paymentType: 'p2tr' })
    .then((resp) => resp.result.signature);
}


/**
 * Leather — `window.LeatherProvider.request('signPsbt', …)`. Leather signs and
 * hands the signed PSBT back; broadcasting is the SDK's job (the "WE broadcast"
 * convention), delegated to the caller's `broadcast` callback. Each signPsbt
 * call surfaces its own confirmation dialog in the wallet.
 */
export const leatherSigner: WalletSigner = makeLeatherFamilySigner({
  walletType: KnownOrdinalWalletType.leather,
  signPsbt: (psbtHex, signAtIndex, network) => {
    if (Array.isArray(signAtIndex)) {
      throw new Error('Leather signs one input index per call (multiInput: chain)');
    }
    const net = toLeatherNetworkString(toWireNetworkFor(KnownOrdinalWalletType.leather, network));
    return callLeatherSignPsbt(psbtHex, signAtIndex, net);
  },
  multiInput: 'chain',
  signMessage: (input: SignMessageArgs): Observable<SignMessageResult> =>
    wrapSignMessage(() => callLeatherSignMessage(input.message)),
});
