import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { defer, from, map, Observable, switchMap } from 'rxjs';

import { toLeatherNetworkString } from '../../network';
import { broadcastSignedPsbt } from '../psbt-extract';
import { findCat21WalletProvider } from '../wallet.service.helper';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMessageArgs,
  SignMessageResult,
  SignMultiInputAndBroadcastInput,
  SignPsbtOnlyInput,
  WalletSigner,
  WindowLike,
} from '../wallet.service.types';
import { operationNamedDefaults } from './operation-named-defaults';
import { resolveSigningTargets } from './signing-targets.helper';


interface Cat21WalletPSBTResponse {
  result: { hex: string };
}

interface Cat21WalletSignPsbtParams {
  hex: string;
  allowedSighash: number[];
  /**
   * Which input indexes to sign. Cat21-wallet accepts either a single
   * number or an array — see
   * `apps/extension/src/background/messaging/rpc-methods/sign-psbt.ts`
   * (ensureArray). Passing an array lets the wallet sign multiple
   * inputs in a SINGLE approval popup, which is essential for the
   * transfer flow (cat input at ordinalsAddress + funding input at
   * paymentAddress).
   */
  signAtIndex: number | number[];
  network: 'mainnet' | 'testnet' | 'signet' | 'sbtcDevenv' | 'devnet' | 'regtest';
  broadcast: false;
}

/**
 * CAT-21 wallet — `window.Cat21Provider.request('signPsbt', …)`.
 *
 * CAT-21 wallet is forked from Leather and inherits Leather's
 * Bitcoin signPsbt JSON-RPC shape verbatim. The wallet signs the
 * PSBT, hands the signed bytes back, and broadcasting is our job
 * via `input.broadcast(...)` (electrs `POST /tx`).
 *
 * Network mapping uses Leather's network strings even though
 * CAT-21 wallet is mainnet-only per its ADR-7 (Stacks/Lightning/
 * testnet UI hidden). The string is still in the request envelope
 * so the wallet's internal validators get what they expect.
 *
 * sighash whitelist is `[SigHash.ALL]` — same as Leather, same as
 * the rest of the SDK's cat-flow path.
 *
 * Multi-input signing: the wallet's `signPsbt` JSON-RPC accepts
 * `signAtIndex` as EITHER a single number or an array. Send the
 * array form for multi-input flows (transfer, offer-accept) — the
 * wallet signs every listed index inside ONE approval popup
 * (see `apps/extension/src/background/messaging/rpc-methods/sign-psbt.ts`
 * → ensureArray).
 */
function callCat21WalletSignPsbt(
  psbtHex: string,
  signAtIndex: number | number[],
  network: Cat21WalletSignPsbtParams['network'],
): Promise<string> {
  const provider = findCat21WalletProvider(window as unknown as WindowLike);
  if (!provider) {
    throw new Error('CAT-21 wallet provider not present (window.Cat21Provider undefined or missing isCat21:true marker)');
  }
  const params: Cat21WalletSignPsbtParams = {
    hex: psbtHex,
    allowedSighash: [btc.SigHash.ALL],
    signAtIndex,
    network,
    broadcast: false,
  };
  return (provider.request('signPsbt', params) as Promise<Cat21WalletPSBTResponse>)
    .then((resp) => resp.result.hex);
}

const legacy = {

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const network = toLeatherNetworkString(input.network);
    return defer(() => from(callCat21WalletSignPsbt(psbtHex, 0, network))).pipe(
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
    const psbtHex = hex.encode(input.psbtBytes);

    return defer(() => from(callCat21WalletSignPsbt(psbtHex, flatIndexes, network))).pipe(
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
    const psbtHex = hex.encode(input.psbtBytes);

    return defer(() => from(callCat21WalletSignPsbt(psbtHex, flatIndexes, network))).pipe(
      map((finalHex) => hex.decode(finalHex)),
    );
  },
};

/**
 * BIP-322 message signing via `window.Cat21Provider.request('signMessage', ...)`.
 *
 * CAT-21 wallet inherits Leather's `signMessage` RPC shape verbatim
 * (forked codebase, same wire format). Params:
 *   - `message`: the UTF-8 string to sign (wallet renders it verbatim
 *     to the user in the approval popup, so the caller MUST pass the
 *     final human-visible bytes — `buildListingMessage()`'s multi-
 *     line output is exactly this).
 *   - `paymentType`: `'p2tr'` forces the ordinals key. Cats live at
 *     the ordinals P2TR address per ordinal theory, and BIP-322
 *     ownership proof needs to be under that key.
 *
 * Wallet response shape: `{ result: { signature: string } }` — the
 * signature is already base64-encoded BIP-322 witness bytes (raw sig
 * OR wrapped-witness format; verifyListingSignature accepts both).
 */
interface Cat21WalletSignMessageResponse {
  result: { signature: string };
}

function callCat21WalletSignMessage(message: string): Promise<string> {
  const provider = findCat21WalletProvider(window as unknown as WindowLike);
  if (!provider) {
    throw new Error('CAT-21 wallet provider not present (window.Cat21Provider undefined or missing isCat21:true marker)');
  }
  return (provider.request('signMessage', { message, paymentType: 'p2tr' }) as Promise<Cat21WalletSignMessageResponse>)
    .then((resp) => resp.result.signature);
}

export const cat21walletSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.cat21wallet,
  ...operationNamedDefaults(legacy),
  signMessage(input: SignMessageArgs): Observable<SignMessageResult> {
    return defer(() => from(callCat21WalletSignMessage(input.message))).pipe(
      map((signature) => ({ signature })),
    );
  },
};
