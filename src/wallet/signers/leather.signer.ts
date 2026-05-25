import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { from, map, Observable, switchMap } from 'rxjs';

import { toLeatherNetworkString } from '../../network';
import { extractWireTxFromPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';


interface LeatherPSBTBroadcastResponse {
  result: { hex: string };
}

interface LeatherSignPsbtRequestParams {
  hex: string;
  allowedSighash: number[];
  signAtIndex: number;
  network: 'mainnet' | 'testnet' | 'signet' | 'sbtcDevenv' | 'devnet';
  broadcast: false;
}

interface LeatherRpcWindow {
  LeatherProvider: {
    request(method: 'signPsbt', params: LeatherSignPsbtRequestParams): Promise<LeatherPSBTBroadcastResponse>;
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
 */
export const leatherSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.leather,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {

    const psbtHex: string = hex.encode(input.psbtBytes);
    const signRequestParams: LeatherSignPsbtRequestParams = {
      hex: psbtHex,
      allowedSighash: [btc.SigHash.ALL],
      signAtIndex: 0,
      network: toLeatherNetworkString(input.network),
      broadcast: false, // we broadcast via input.broadcast(...)
    };

    const win = window as unknown as LeatherRpcWindow;
    const signPromise = win.LeatherProvider.request('signPsbt', signRequestParams);

    return from(signPromise).pipe(
      switchMap(resp => {
        const txHex = extractWireTxFromPsbt(hex.decode(resp.result.hex));
        return input.broadcast(txHex).pipe(map(txId => ({ txId })));
      })
    );
  },
};
