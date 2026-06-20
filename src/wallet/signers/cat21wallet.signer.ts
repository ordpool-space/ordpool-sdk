import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { defer, from, map, Observable, switchMap } from 'rxjs';

import { toLeatherNetworkString } from '../../network';
import { broadcastSignedPsbt } from '../psbt-extract';
import { findCat21WalletProvider } from '../wallet.service.helper';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
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
  signAtIndex: number;
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
 * Multi-input signing: the wallet's `signPsbt` JSON-RPC takes a
 * single `signAtIndex`. For flows that need multiple inputs signed
 * (transfer, offer-accept) the multi method iterates the flat
 * index list, threading the partially-signed PSBT hex through each
 * call. Each call shows a confirmation dialog so the user sees and
 * approves every signature.
 */
function callCat21WalletSignPsbt(
  psbtHex: string,
  signAtIndex: number,
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

    return defer(() => {
      let chain: Promise<string> = Promise.resolve(hex.encode(input.psbtBytes));
      for (const i of flatIndexes) {
        chain = chain.then((currentHex) => callCat21WalletSignPsbt(currentHex, i, network));
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
        chain = chain.then((currentHex) => callCat21WalletSignPsbt(currentHex, i, network));
      }
      return from(chain);
    }).pipe(map((finalHex) => hex.decode(finalHex)));
  },
};

export const cat21walletSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.cat21wallet,
  ...operationNamedDefaults(legacy),
};
