import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { defer, from, map, Observable, switchMap } from 'rxjs';

import { toLeatherNetworkString } from '../../network';
import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMessageArgs,
  SignMessageResult,
  SignMultiInputAndBroadcastInput,
  SignPsbtOnlyInput,
  WalletSigner,
} from '../wallet.service.types';
import { operationNamedDefaults } from './operation-named-defaults';
import { resolveSigningTargets } from './signing-targets.helper';


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
   * Which key signs. `'p2tr'` selects the taproot / ordinals key —
   * the one BIP-322 for CAT-21 listings needs (cats live on the
   * ordinals key per ordinal theory).
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
 * Leather — `window.LeatherProvider.request('signPsbt', …)`.
 *
 * Leather signs and hands the signed PSBT back to us; broadcasting
 * is our job. The signed PSBT is finalised via @scure/btc-signer,
 * then we delegate the broadcast to the caller's `broadcast`
 * callback (which hits electrs `POST /tx` via the configured
 * HttpClient).
 *
 * Namespace: `window.LeatherProvider`, NOT the historical
 * `window.btc`. The `window.btc` global is the old Hiro namespace
 * that other extensions (Unisat in some versions) have aggressively
 * overwritten; users with multiple wallet extensions installed have
 * hit our code routing to the wrong wallet. See the multi-injection
 * section of PLAN-wallet-roster.md.
 *
 * Multi-input signing: Leather's signPsbt takes a single
 * `signAtIndex`. For flows that need multiple inputs signed the
 * multi method iterates the flat index list, threading the
 * partially-signed PSBT hex through each call. Same pattern as
 * cat21-wallet (which is a Leather fork). Each call surfaces a
 * confirmation dialog in the wallet.
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

const legacy = {

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const network = toLeatherNetworkString(input.network);
    return defer(() => from(callLeatherSignPsbt(psbtHex, 0, network))).pipe(
      switchMap((signedHex) => broadcastSignedPsbt(input, hex.decode(signedHex))),
    );
  },

  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    const targets = resolveSigningTargets(input);
    const flatIndexes: number[] = [];
    for (const t of targets) {
      for (const i of t.indexes) flatIndexes.push(i);
    }
    const network = toLeatherNetworkString(input.network);

    return defer(() => {
      let chain: Promise<string> = Promise.resolve(hex.encode(input.psbtBytes));
      for (const i of flatIndexes) {
        chain = chain.then((currentHex) => callLeatherSignPsbt(currentHex, i, network));
      }
      return from(chain);
    }).pipe(
      switchMap((finalHex) => broadcastSignedPsbt(input, hex.decode(finalHex))),
    );
  },

  signPsbtOnly(input: SignPsbtOnlyInput): Observable<Uint8Array> {
    const targets = resolveSigningTargets(input);
    const flatIndexes: number[] = [];
    for (const t of targets) {
      for (const i of t.indexes) flatIndexes.push(i);
    }
    const network = toLeatherNetworkString(input.network);

    return defer(() => {
      let chain: Promise<string> = Promise.resolve(hex.encode(input.psbtBytes));
      for (const i of flatIndexes) {
        chain = chain.then((currentHex) => callLeatherSignPsbt(currentHex, i, network));
      }
      return from(chain);
    }).pipe(map((finalHex) => hex.decode(finalHex)));
  },
};

/**
 * BIP-322 message signing via `window.LeatherProvider.request('signMessage', ...)`.
 * `paymentType: 'p2tr'` forces the ordinals key. Wallet response's
 * `result.signature` is already base64-encoded BIP-322 witness bytes.
 */
function callLeatherSignMessage(message: string): Promise<string> {
  const win = window as unknown as LeatherRpcWindow;
  return win.LeatherProvider.request('signMessage', { message, paymentType: 'p2tr' })
    .then((resp) => resp.result.signature);
}

export const leatherSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.leather,
  ...operationNamedDefaults(legacy),
  signMessage(input: SignMessageArgs): Observable<SignMessageResult> {
    return defer(() => from(callLeatherSignMessage(input.message))).pipe(
      map((signature) => ({ signature })),
    );
  },
};
