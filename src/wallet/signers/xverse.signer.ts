import { base64 } from '@scure/base';
import { from, Observable, map, switchMap } from 'rxjs';
import Wallet, { MessageSigningProtocols } from 'sats-connect';

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
import { wrapSignMessage } from './wrap-sign-message';


/**
 * Xverse — sats-connect v4 `Wallet.request('signPsbt', ...)`, the modern
 * RPC API. The deprecated callback-style `signTransaction` (with its
 * explicit `network` + per-input `sigHash`) is gone.
 *
 * `signInputs` maps address → the input indexes to sign; the wallet
 * signs ONLY those and leaves every other input untouched — which is
 * how multi-input PSBTs (a marketplace sale, or our child-inscribe
 * reveal whose input 1 is the ephemeral commit) get signed. The
 * per-input sighash rides on the PSBT (SIGHASH_ALL on segwit funding
 * inputs, SIGHASH_DEFAULT on taproot), so no explicit sighash arg.
 *
 * Per the SDK-wide "WE broadcast" convention (`/Work/ordpool/WALLETS.md`):
 * always `broadcast: false`, extract the wire tx ourselves, hand it to
 * `input.broadcast(rawTxHex)`. NEVER mempool.space (host-banned, see
 * workspace `CLAUDE.md`).
 */
function callXverseSignPsbt(
  psbtBytes: Uint8Array,
  signInputs: Record<string, number[]>,
): Observable<string> {
  const psbt = base64.encode(psbtBytes);
  return from(
    Wallet.request('signPsbt', { psbt, signInputs, broadcast: false }).then((resp) => {
      if (resp.status !== 'success') {
        throw new Error(
          `Xverse signPsbt failed: ${resp.error?.message ?? 'unknown error'} (code ${resp.error?.code ?? '?'})`,
        );
      }
      return resp.result.psbt; // base64 signed PSBT
    }),
  );
}

/** Collapse resolved signing targets into signPsbt's address→indexes map. */
function toSignInputs(
  targets: ReadonlyArray<{ address: string; indexes: number[] }>,
): Record<string, number[]> {
  const signInputs: Record<string, number[]> = {};
  for (const t of targets) {
    signInputs[t.address] = [...(signInputs[t.address] ?? []), ...t.indexes];
  }
  return signInputs;
}

const legacy = {
  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    return callXverseSignPsbt(input.psbtBytes, { [input.paymentAddress]: [0] }).pipe(
      switchMap((signedPsbtBase64) => broadcastSignedPsbt(input, base64.decode(signedPsbtBase64))),
    );
  },

  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    return callXverseSignPsbt(input.psbtBytes, toSignInputs(resolveSigningTargets(input))).pipe(
      switchMap((signedPsbtBase64) => broadcastSignedPsbt(input, base64.decode(signedPsbtBase64))),
    );
  },

  signPsbtOnly(input: SignPsbtOnlyInput): Observable<Uint8Array> {
    return callXverseSignPsbt(input.psbtBytes, toSignInputs(resolveSigningTargets(input))).pipe(
      map((signedPsbtBase64) => base64.decode(signedPsbtBase64)),
    );
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
  signMessage: (input: SignMessageArgs): Observable<SignMessageResult> =>
    wrapSignMessage(() => callXverseSignMessage(input.address, input.message)),
};
