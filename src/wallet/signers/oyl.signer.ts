import { base64, hex } from '@scure/base';
import { from, map, Observable, switchMap } from 'rxjs';

import { walletSidePaymentAddress } from '../network-address-shim';
import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMultiInputAndBroadcastInput,
  SignPsbtOnlyInput,
  WalletSigner,
} from '../wallet.service.types';
import { operationNamedDefaults } from './operation-named-defaults';
import { unsupportedSignMessage } from './unsupported-sign-message';
import { resolveSigningTargets } from './signing-targets.helper';


interface OylInputToSign {
  address: string;
  signingIndexes: number[];
  sigHash?: number;
}

interface OylRpc {
  signPsbt(args: {
    psbt: string;
    inputsToSign?: OylInputToSign[];
    broadcast?: boolean;
    finalize?: boolean;
  }): Promise<{ signedPsbt?: string; signedPsbtHex?: string; psbt?: string }>;
}


/**
 * Oyl — `window.oyl.signPsbt({psbt, inputsToSign, broadcast,
 * finalize})`.
 *
 * Oyl exposes a single `window.oyl` provider whose methods route
 * via its relay-based messaging shim to the extension background.
 *
 * Schema verified by grepping v1.17.1's static/background/index.js
 * (signPsbt handler at byte 4708500):
 *   - `body.psbt` is a hex string. The error message
 *     "A psbt hex is required" refers to the value TYPE, not the
 *     field name; passing base64 here gets rejected.
 *   - Response may use `signedPsbtHex` (hex), `signedPsbt` (base64),
 *     or `psbt` (whichever shape Oyl emits for that version). The
 *     signer normalises by sniffing.
 *
 * Per the SDK-wide "WE broadcast" convention, we set
 * `broadcast: false, finalize: false` so Oyl returns the
 * partial-sig PSBT for us to finalize via scure +
 * broadcastSignedPsbt.
 */
function decodeOylResponse(r: { signedPsbt?: string; signedPsbtHex?: string; psbt?: string }): Uint8Array {
  if (r.signedPsbtHex) return hex.decode(r.signedPsbtHex);
  if (r.signedPsbt) return base64.decode(r.signedPsbt);
  if (r.psbt) {
    return /^[0-9a-f]+$/i.test(r.psbt) ? hex.decode(r.psbt) : base64.decode(r.psbt);
  }
  throw new Error('Oyl signPsbt response carried no signed-psbt field');
}

const legacy = {

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const oyl = (window as unknown as { oyl: OylRpc }).oyl;
    const walletAddress = walletSidePaymentAddress(
      KnownOrdinalWalletType.oyl,
      input.paymentAddress,
      input.paymentPublicKey,
    );
    const signPromise = oyl.signPsbt({
      psbt: psbtHex,
      inputsToSign: [{ address: walletAddress, signingIndexes: [0], sigHash: 0x01 }],
      broadcast: false,
      finalize: false,
    });
    return from(signPromise).pipe(
      switchMap(response => broadcastSignedPsbt(input, decodeOylResponse(response))),
    );
  },

  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const oyl = (window as unknown as { oyl: OylRpc }).oyl;
    const targets = resolveSigningTargets(input);
    const inputsToSign = targets.map((t) => ({
      address: walletSidePaymentAddress(KnownOrdinalWalletType.oyl, t.address, input.paymentPublicKey),
      signingIndexes: t.indexes,
      sigHash: t.sigHash,
    }));
    const signPromise = oyl.signPsbt({
      psbt: psbtHex,
      inputsToSign,
      broadcast: false,
      finalize: false,
    });
    return from(signPromise).pipe(
      switchMap(response => broadcastSignedPsbt(input, decodeOylResponse(response))),
    );
  },

  signPsbtOnly(input: SignPsbtOnlyInput): Observable<Uint8Array> {
    const psbtHex = hex.encode(input.psbtBytes);
    const oyl = (window as unknown as { oyl: OylRpc }).oyl;
    const targets = resolveSigningTargets(input);
    const inputsToSign = targets.map((t) => ({
      address: walletSidePaymentAddress(KnownOrdinalWalletType.oyl, t.address, input.paymentPublicKey),
      signingIndexes: t.indexes,
      sigHash: t.sigHash,
    }));
    return from(oyl.signPsbt({
      psbt: psbtHex,
      inputsToSign,
      broadcast: false,
      finalize: false,
    })).pipe(
      map((response) => decodeOylResponse(response)),
    );
  },
};

export const oylSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.oyl,
  ...operationNamedDefaults(legacy),
  signMessage: unsupportedSignMessage('Oyl'),
};
