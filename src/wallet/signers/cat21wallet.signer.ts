import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { from, Observable, switchMap } from 'rxjs';

import { toLeatherNetworkString } from '../../network';
import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';


interface Cat21WalletPSBTResponse {
  result: { hex: string };
}

interface Cat21WalletSignPsbtParams {
  hex: string;
  allowedSighash: number[];
  signAtIndex: number;
  network: 'mainnet' | 'testnet' | 'signet' | 'sbtcDevenv' | 'devnet';
  broadcast: false;
}

interface Cat21WalletRpcWindow {
  Cat21Provider: {
    request(method: 'signPsbt', params: Cat21WalletSignPsbtParams): Promise<Cat21WalletPSBTResponse>;
  };
}


/**
 * Cat21 Wallet — `window.Cat21Provider.request('signPsbt', …)`.
 *
 * Cat21 Wallet is forked from Leather and inherits Leather's
 * Bitcoin signPsbt JSON-RPC shape verbatim. The wallet signs the
 * PSBT, hands the signed bytes back, and broadcasting is our job
 * via `input.broadcast(...)` (electrs `POST /tx`).
 *
 * Network mapping uses Leather's network strings even though
 * Cat21 Wallet is mainnet-only per its ADR-7 (Stacks/Lightning/
 * testnet UI hidden). The string is still in the request envelope
 * so the wallet's internal validators get what they expect.
 *
 * sighash whitelist is `[SigHash.ALL]` — same as Leather, same as
 * the rest of the SDK's mint roundtrip path. The Cat21 mint PSBT
 * commits to all outputs under SIGHASH_ALL; anything else would be
 * rejected by `assertAllInputsSighashAll` after broadcast.
 */
export const cat21walletSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.cat21wallet,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {

    const psbtHex: string = hex.encode(input.psbtBytes);
    const signRequestParams: Cat21WalletSignPsbtParams = {
      hex: psbtHex,
      allowedSighash: [btc.SigHash.ALL],
      signAtIndex: 0,
      network: toLeatherNetworkString(input.network),
      broadcast: false, // we broadcast via input.broadcast(...)
    };

    const win = window as unknown as Cat21WalletRpcWindow;
    const signPromise = win.Cat21Provider.request('signPsbt', signRequestParams);

    return from(signPromise).pipe(
      switchMap(resp => broadcastSignedPsbt(input, hex.decode(resp.result.hex))),
    );
  },
};
