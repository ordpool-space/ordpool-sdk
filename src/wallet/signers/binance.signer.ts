import { hex } from '@scure/base';
import { from, map, Observable, switchMap } from 'rxjs';

import { broadcastSignedPsbt } from '../psbt-extract';
import { BIP341_KEYPATH_SIGHASHES } from '../sighash';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMultiInputAndBroadcastInput,
  SignPsbtOnlyInput,
  WalletSigner,
} from '../wallet.service.types';
import { resolveSigningTargets } from './signing-targets.helper';


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
          // BIP-341 key-path: DEFAULT (0x00) and ALL (0x01) cover
          // identical wire bytes; accept either so the wallet's
          // policy check passes regardless of which shape the SDK
          // emits on the Taproot input.
          sighashTypes: [...BIP341_KEYPATH_SIGHASHES],
        }],
      }),
    ).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },

  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const binanceBtc = (window as unknown as { binancew3w: { bitcoin: BinanceBtcRpc } }).binancew3w.bitcoin;

    const targets = resolveSigningTargets(input);
    const toSignInputs: { index: number; address?: string; sighashTypes?: number[] }[] = [];
    for (const t of targets) {
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
      }
    }

    return from(binanceBtc.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },

  signPsbtOnly(input: SignPsbtOnlyInput): Observable<Uint8Array> {
    const psbtHex = hex.encode(input.psbtBytes);
    const binanceBtc = (window as unknown as { binancew3w: { bitcoin: BinanceBtcRpc } }).binancew3w.bitcoin;
    const targets = resolveSigningTargets(input);
    const toSignInputs: { index: number; address?: string; sighashTypes?: number[] }[] = [];
    for (const t of targets) {
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
      }
    }
    return from(binanceBtc.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      map((signedPsbtHex) => hex.decode(signedPsbtHex)),
    );
  },
};
