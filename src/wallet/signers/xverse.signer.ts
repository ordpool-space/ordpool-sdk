import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { defer, from, Observable, map, switchMap } from 'rxjs';
import Wallet, { MessageSigningProtocols, signTransaction } from 'sats-connect';

import { toBitcoinNetworkType } from '../../network';
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


/**
 * Xverse — sats-connect v4 `signTransaction` (callback-style).
 *
 * Per the SDK-wide "WE broadcast" convention (see
 * `/Work/ordpool/WALLETS.md`): we ask Xverse to sign only
 * (`broadcast: false`), extract the wire-format tx ourselves, and
 * hand it to `input.broadcast(rawTxHex)`. The caller's broadcast
 * callback decides the endpoint — electrs, api.ordpool.space, or
 * a future non-standard-relay path. NEVER mempool.space (host-banned,
 * see workspace `CLAUDE.md`).
 *
 * Migration to sats-connect v3+ `provider.request('signPsbt', ...)`
 * is a separate stream.
 */
function callXverseSignTransaction(
  psbtBytes: Uint8Array,
  inputsToSign: { address: string; signingIndexes: number[]; sigHash: number }[],
  network: Parameters<typeof signTransaction>[0]['payload']['network']['type'],
  message: string,
): Observable<string> {
  const psbtBase64 = base64.encode(psbtBytes);
  return new Observable<string>((observer) => {
    signTransaction({
      payload: {
        network: { type: network },
        message,
        psbtBase64,
        broadcast: false,
        inputsToSign,
      },
      onFinish: (response) => {
        const signed = (response as { psbtBase64?: string }).psbtBase64;
        if (!signed) {
          observer.error(new Error('Xverse signTransaction returned without psbtBase64'));
          return;
        }
        observer.next(signed);
        observer.complete();
      },
      onCancel: () => observer.error(new Error('Request was cancelled')),
    });
  });
}

const legacy = {
  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const networkType = toBitcoinNetworkType(input.network) as unknown as Parameters<typeof signTransaction>[0]['payload']['network']['type'];
    return callXverseSignTransaction(
      input.psbtBytes,
      [{ address: input.paymentAddress, signingIndexes: [0], sigHash: btc.SigHash.ALL }],
      networkType,
      'Sign Transaction (CAT-21 Mint)',
    ).pipe(
      switchMap((signedPsbtBase64) => broadcastSignedPsbt(input, base64.decode(signedPsbtBase64))),
    );
  },

  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    const networkType = toBitcoinNetworkType(input.network) as unknown as Parameters<typeof signTransaction>[0]['payload']['network']['type'];
    const targets = resolveSigningTargets(input);
    const inputsToSign = targets.map((t) => ({
      address: t.address,
      signingIndexes: t.indexes,
      sigHash: t.sigHash,
    }));
    return callXverseSignTransaction(
      input.psbtBytes,
      inputsToSign,
      networkType,
      'Sign CAT-21 transaction',
    ).pipe(
      switchMap((signedPsbtBase64) => broadcastSignedPsbt(input, base64.decode(signedPsbtBase64))),
    );
  },

  signPsbtOnly(input: SignPsbtOnlyInput): Observable<Uint8Array> {
    const networkType = toBitcoinNetworkType(input.network) as unknown as Parameters<typeof signTransaction>[0]['payload']['network']['type'];
    const targets = resolveSigningTargets(input);
    const inputsToSign = targets.map((t) => ({
      address: t.address,
      signingIndexes: t.indexes,
      sigHash: t.sigHash,
    }));
    return callXverseSignTransaction(
      input.psbtBytes,
      inputsToSign,
      networkType,
      'Sign CAT-21 buy offer (no broadcast)',
    ).pipe(map((signedPsbtBase64) => base64.decode(signedPsbtBase64)));
  },
};

/**
 * BIP-322 message signing via sats-connect v3+ `Wallet.request('signMessage', ...)`.
 *
 * `protocol: MessageSigningProtocols.BIP322` selects BIP-322 (vs
 * ECDSA — the older Sparrow-style prefixed-message format). Xverse
 * returns a `{ status: 'success', result: { signature } }` envelope;
 * `signature` is already base64-encoded BIP-322 witness bytes.
 *
 * The `address` arg drives which key the wallet signs with — must
 * be the ordinals P2TR address (cats live on the ordinals key per
 * ordinal theory). Caller passes this through from
 * `wallet.ordinalsAddress`.
 */
function callXverseSignMessage(address: string, message: string): Promise<string> {
  return Wallet.request('signMessage', {
    address,
    message,
    protocol: MessageSigningProtocols.BIP322,
  }).then((resp) => {
    if (resp.status !== 'success') {
      throw new Error(
        `Xverse signMessage failed: ${resp.error?.message ?? 'unknown error'} (code ${resp.error?.code ?? '?'})`,
      );
    }
    return resp.result.signature;
  });
}

export const xverseSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.xverse,
  ...operationNamedDefaults(legacy),
  signMessage(input: SignMessageArgs): Observable<SignMessageResult> {
    return defer(() => from(callXverseSignMessage(input.address, input.message))).pipe(
      map((signature) => ({ signature })),
    );
  },
};
