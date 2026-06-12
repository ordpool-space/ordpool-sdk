import { hex } from '@scure/base';
import { from, Observable, switchMap } from 'rxjs';

import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';


interface BinanceBtcRpc {
  signPsbt(
    psbtHex: string,
    options?: {
      autoFinalized?: boolean;
      toSignInputs?: { index: number; address?: string; publicKey?: string; sighashTypes?: number[]; disableTweakSigner?: boolean }[];
    },
  ): Promise<string>;
}


/**
 * Binance Web3 Wallet — `window.binancew3w.bitcoin.signPsbt(hex,
 * {autoFinalized: false, toSignInputs: […]})`.
 *
 * Shape pulled from the LaserEyes `binance.ts` provider
 * (omnisat/lasereyes-mono) which is in production use across
 * multiple Ordinals-related projects, cross-checked against the
 * developer docs at developers.binance.com/docs/binance-w3w
 * /bitcoin-provider. Per the SDK-wide "WE broadcast" convention,
 * we pass `autoFinalized: false` and route through the shared
 * broadcastSignedPsbt helper.
 *
 * **Runtime status:** the shipped v1.17.2 binary doesn't inject
 * `window.binancew3w.bitcoin` (only wallet / ethereum / solana /
 * tron / sui / tonconnect), so this signer is unreachable on
 * current Binance Web3 Wallet installs. Detect-by-signature in
 * `binance.connector.ts` correctly returns false, so the wallet
 * doesn't surface in the picker and this code isn't called.
 * Ships as potential-support; lights up automatically when
 * Binance enables the documented surface.
 */
export const binanceSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.binance,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex: string = hex.encode(input.psbtBytes);
    const binanceBtc = (window as unknown as { binancew3w: { bitcoin: BinanceBtcRpc } }).binancew3w.bitcoin;

    return from(
      binanceBtc.signPsbt(psbtHex, {
        autoFinalized: false,
        toSignInputs: [{
          index: 0,
          address: input.paymentAddress,
          sighashTypes: [0x01], // SIGHASH_ALL
        }],
      }),
    ).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },
};
