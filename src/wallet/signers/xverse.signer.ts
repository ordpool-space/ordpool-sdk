import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { defer, from, Observable, map, switchMap } from 'rxjs';
import { MessageSigningProtocols, request, signTransaction } from 'sats-connect';

import { toBitcoinNetworkType } from '../../network';
import { broadcastSignedPsbt, extractWireTxFromPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignChildRevealParentInputsArgs,
  SignMessageArgs,
  SignMessageResult,
  SignMultiInputAndBroadcastInput,
  SignOfferAcceptArgs,
  SignOfferCreatePsbtArgs,
  SignPsbtOnlyInput,
  SignTransferArgs,
  WalletSigner,
} from '../wallet.service.types';
import { mergeParentSigAndBroadcast, prepareOfferAcceptWalletFacing } from './child-reveal-finalize.helper';
import { operationNamedDefaults } from './operation-named-defaults';
import { resolveSigningTargets } from './signing-targets.helper';
import { wrapSignMessage } from './wrap-sign-message';


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
 * BIP-322 message signing via the low-level sats-connect `request`
 * helper (re-exported from `@sats-connect/core`), NOT the default
 * `Wallet.request` method. Same reason as `callXverseSignPsbtModern`
 * above: `Wallet.request` wraps calls in sats-connect's in-page UI
 * (`loadSelector`/`walletOpen`) — a "Choose wallet to connect" picker
 * that a programmatic caller can't dismiss and that a connected user
 * should never see just to sign a message. Bare `request` reaches
 * `provider.request('signMessage', …)` directly.
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
  return request('signMessage', {
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

/**
 * Modern sats-connect `signPsbt` via the low-level `request` helper
 * (re-exported from `@sats-connect/core`), NOT the default
 * `Wallet.request` method — the latter wraps calls in sats-connect's
 * in-page UI (`loadSelector`/`walletOpen`) that a programmatic caller
 * can't dismiss. Bare `request` reaches `provider.request('signPsbt',
 * …)` directly.
 *
 * `signInputs` is `Record<address, number[]>` — the wallet signs only
 * the listed input indexes and leaves every other input (here the
 * foreign ephemeral-commit input) untouched, the marketplace multi-
 * input pattern. `signPsbt` carries no per-request network; it follows
 * the wallet's active network (regtest in the e2e seed).
 */
function callXverseSignPsbtModern(
  psbtBytes: Uint8Array,
  signInputs: Record<string, number[]>,
): Observable<Uint8Array> {
  const psbt = base64.encode(psbtBytes);
  return from(request('signPsbt', { psbt, signInputs, broadcast: false })).pipe(
    map((resp) => {
      if (resp.status !== 'success') {
        throw new Error(
          `Xverse signPsbt failed: ${resp.error?.message ?? 'unknown error'} (code ${resp.error?.code ?? '?'})`,
        );
      }
      return base64.decode(resp.result.psbt);
    }),
  );
}

/** Decode an x-only (64-hex) or compressed (66-hex) pubkey to 32 x-only bytes. */
function xOnlyBytes(pubHex: string): Uint8Array {
  const s = pubHex.startsWith('0x') ? pubHex.slice(2) : pubHex;
  return hex.decode(s.length === 66 ? s.slice(2) : s);
}

export const xverseSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.xverse,
  ...operationNamedDefaults(legacy),
  signMessage: (input: SignMessageArgs): Observable<SignMessageResult> =>
    wrapSignMessage(() => callXverseSignMessage(input.address, input.message)),

  /**
   * Child-inscription reveal: the wallet signs ONLY input 0 (its parent
   * P2TR UTXO) via modern `signPsbt` with `signInputs` scoped to the
   * ordinals address; the foreign ephemeral-commit input 1 is left
   * alone. The legacy `signTransaction` path (used by the generic
   * `signPsbtOnly`) stalls on the foreign input, so this operation is
   * overridden onto modern `signPsbt`. The signed input-0 key-path
   * signature is then merged into the full reveal PSBT and broadcast by
   * the shared tail.
   */
  signChildRevealParentInputs: (input: SignChildRevealParentInputsArgs): Observable<{ txId: string }> => {
    // Input 0 (the parent P2TR key-path) already carries its tapInternalKey
    // on the bare wallet-facing PSBT, so signPsbt signs it directly; input 1
    // (the foreign ephemeral-commit) is left untouched. Merge input 0's
    // signature onto the FULL reveal PSBT (input 1 there carries the envelope
    // tapLeafScript + tapScriptSig) so both inputs finalize before broadcast.
    return callXverseSignPsbtModern(input.psbtBytes, { [input.ordinalsAddress]: [0] }).pipe(
      switchMap((signedBare) =>
        mergeParentSigAndBroadcast(signedBare, input.finalizePsbtBytes, input.broadcast)),
    );
  },

  /**
   * Transfer, offer-accept, offer-create all route onto modern `signPsbt`
   * for the same reason as child-reveal: Xverse's legacy `signTransaction`
   * stalls on a multi-input PSBT (and hard-hangs when an input is foreign,
   * as both offer PSBTs carry — the seller's unsigned cat input on create,
   * the buyer's pre-signed funding input on accept). Bare `request(
   * 'signPsbt', { signInputs })` signs only the listed indexes and leaves
   * the rest untouched — the marketplace pattern. `signInputs` addresses
   * are the wallet's active-network (regtest in the e2e seed) addresses,
   * matching the child-reveal override.
   */
  signTransfer: (input: SignTransferArgs): Observable<{ txId: string }> => {
    const paymentIndexes = Array.from({ length: input.fundingInputCount }, (_, i) => i + 1);
    return callXverseSignPsbtModern(input.psbtBytes, {
      [input.ordinalsAddress]: [0],
      [input.paymentAddress]: paymentIndexes,
    }).pipe(
      switchMap((signedPsbt) => input.broadcast(extractWireTxFromPsbt(signedPsbt)).pipe(
        map((txId) => ({ txId })),
      )),
    );
  },

  signOfferAccept: (input: SignOfferAcceptArgs): Observable<{ txId: string }> => {
    // Xverse's modern signPsbt hangs on a PSBT whose input 1 is already
    // buyer-signed, and refuses a Taproot input 0 that carries no
    // tapInternalKey. Reshape to the proven child-reveal form — input 0
    // gains its tapInternalKey, input 1 is stripped to its witnessUtxo —
    // sign ONLY input 0, then merge that sig onto the full buyer-signed PSBT
    // so both inputs finalize.
    const bare = prepareOfferAcceptWalletFacing(input.psbtBytes, xOnlyBytes(input.ordinalsPublicKey));
    return callXverseSignPsbtModern(bare, { [input.ordinalsAddress]: [0] }).pipe(
      switchMap((signedBare) =>
        mergeParentSigAndBroadcast(signedBare, input.psbtBytes, input.broadcast)),
    );
  },

  signOfferCreatePsbt: (input: SignOfferCreatePsbtArgs): Observable<Uint8Array> => {
    // Xverse (buyer) signs ONLY its funding inputs 1..N; input 0 (the
    // seller's cat) stays unsigned for the seller to sign later. Return the
    // partial PSBT bytes; no broadcast on this path.
    const paymentIndexes = Array.from({ length: input.fundingInputCount }, (_, i) => i + 1);
    return callXverseSignPsbtModern(input.psbtBytes, { [input.paymentAddress]: paymentIndexes });
  },
};
