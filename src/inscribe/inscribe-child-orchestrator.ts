import { Observable, defer, map, switchMap, throwError } from 'rxjs';
import { hex } from '@scure/base';

import { findSignerOrThrow } from '../wallet/signers';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { Network } from '../network';
import { TxnOutput } from '../cat21-mint/cat21.service.types';

import {
  CreateChildInscribeTransactionsResult,
  createChildInscribeTransactions,
} from './inscription.service.helper';
import { ChildRevealParent } from './inscription-child-reveal.helper';
import { OrdEnvelopeField } from './inscription-envelope';
import type { InscriptionContentEncoding } from './inscribe-compression.helper';

/**
 * Public orchestrator for the ord parent/child (provenance) inscribe.
 * Composes builder + signer + broadcast for Path 2/3:
 *
 *   1. `createChildInscribeTransactions` — commit PSBT + a CHILD reveal
 *      PSBT (parent input unsigned, commit input ephemeral-finalized).
 *   2. `signSingleFundingInput` — the wallet signs the commit's funding
 *      input; broadcast the commit.
 *   3. `signChildRevealParentInputs` — the wallet signs the reveal's
 *      PARENT input (index 0, the ordinals key that owns the parent);
 *      the commit input (index 1) is already witnessed; broadcast.
 *
 * The parent inscription is spent (proving control) and returned to the
 * wallet, and the child is created with the `parent` tag — which is what
 * makes ord recognise the provenance link. See
 * `inscription-child-reveal.helper.ts` for the topology + safety.
 */
export interface InscribeChildAndBroadcastArgs {
  paymentOutput: TxnOutput;
  paymentPublicKey: Uint8Array;
  paymentAddress: string;
  /** Where the CHILD inscription lands. */
  recipientAddress: string;
  body: Uint8Array;
  contentType?: string;
  envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
  feeRatePerVbyte: number;
  walletType: KnownOrdinalWalletType;
  tip?: { address: string; value: number };
  note?: string;
  contentEncoding?: InscriptionContentEncoding;
  pointer?: number;
  metadata?: Uint8Array;
  metaprotocol?: string;
  delegate?: string;
  rune?: bigint;
  properties?: Uint8Array;
  propertyEncoding?: 'br';
  /**
   * Tag push-encoding choice. `false` (default) = data push (ord-standard,
   * charm-free); `true` = pushnum for tags 1–16 (1 byte smaller, ord's
   * `vindicated` charm). See `createInscribeTransactions`.
   */
  minimalTagPush?: boolean;
  /** The parent inscription id (`<txid>i<index>`) — the `parent` tag. */
  parentInscriptionId: string;
  /**
   * The parent inscription's CURRENT UTXO (spent by the reveal) + where it
   * returns. For the in-wallet case both belong to the connected wallet;
   * `parentUtxo.returnAddress` is the ordinals address the wallet signs at.
   */
  parentUtxo: ChildRevealParent;
  network: Network;
  broadcast(txHex: string): Observable<string>;
  /** Fired with the wallet-signed commit hex before broadcast. */
  onCommitSigned?(signedCommitHex: string): void;
  promptForSignedPsbt?(unsigned: { base64: string; hex: string }): Observable<string>;
}

export interface InscribeChildAndBroadcastResult {
  commitTxId: string;
  revealTxId: string;
  /** The child's inscription id (`<revealTxId>i0`). */
  childInscriptionId: string;
  commitAddress: string;
  /** Ephemeral bearer key — persist or forfeit reveal-side flexibility. */
  ephemeral: CreateChildInscribeTransactionsResult['ephemeral'];
  fees: CreateChildInscribeTransactionsResult['fees'];
}

export function inscribeChildAndBroadcast(
  args: InscribeChildAndBroadcastArgs,
): Observable<InscribeChildAndBroadcastResult> {
  return defer(() => {
    let built: CreateChildInscribeTransactionsResult;
    try {
      built = createChildInscribeTransactions({
        paymentOutput: args.paymentOutput,
        paymentPublicKey: args.paymentPublicKey,
        paymentAddress: args.paymentAddress,
        recipientAddress: args.recipientAddress,
        body: args.body,
        contentType: args.contentType,
        envelopeFields: args.envelopeFields,
        feeRatePerVbyte: args.feeRatePerVbyte,
        walletType: args.walletType,
        tip: args.tip,
        note: args.note,
        contentEncoding: args.contentEncoding,
        pointer: args.pointer,
        metadata: args.metadata,
        metaprotocol: args.metaprotocol,
        delegate: args.delegate,
        rune: args.rune,
        properties: args.properties,
        propertyEncoding: args.propertyEncoding,
        minimalTagPush: args.minimalTagPush,
        parentInscriptionId: args.parentInscriptionId,
        parentUtxo: args.parentUtxo,
        // OKX-only real-key path: make the commit input OWNED by OKX (its
        // ordinals x-only key is the envelope leaf + commit internal key)
        // so OKX signs both reveal inputs in one signPsbt call. OKX is
        // single-address (payment === ordinals), so the parent's
        // tapInternalKey IS OKX's ordinals key. Every other wallet leaves
        // this unset and uses the default ephemeral-key path.
        revealKeyXOnly: args.walletType === KnownOrdinalWalletType.okx
          ? args.parentUtxo.utxo.tapInternalKey
          : undefined,
        network: args.network,
      });
    } catch (err) {
      return throwError(() => err);
    }

    const signer = findSignerOrThrow(args.walletType);

    // OKX-owned-commit mode returns ONE reveal PSBT the wallet signs (both
    // inputs) and the SDK finalizes. Every other wallet gets the bare
    // wallet-facing PSBT (input 0) + the full finalize PSBT (input 1
    // ephemeral-signed) split. `revealPsbtForOwnedCommit` is only set in
    // OKX mode, so the `??` selects the right pair without re-checking the
    // wallet type.
    const ownedCommitReveal = built.revealPsbtForOwnedCommit;

    const captureAndBroadcast = (signedCommitHex: string): Observable<string> => {
      if (args.onCommitSigned) {
        try { args.onCommitSigned(signedCommitHex); } catch { /* swallow */ }
      }
      return args.broadcast(signedCommitHex);
    };

    return signer.signSingleFundingInput({
      psbtBytes: built.commitPsbt,
      paymentAddress: args.paymentAddress,
      paymentPublicKey: hex.encode(args.paymentPublicKey),
      network: args.network,
      broadcast: captureAndBroadcast,
      promptForSignedPsbt: args.promptForSignedPsbt,
    }).pipe(
      switchMap(({ txId: commitTxId }) =>
        signer.signChildRevealParentInputs({
          // Default: wallet signs input 0 on the BARE PSBT (no envelope
          // tap-leaf); its signature is merged into the full PSBT to
          // finalize. OKX: the owned-commit PSBT is both the sign target
          // (wallet signs both inputs) and the finalize target.
          psbtBytes: ownedCommitReveal ?? built.revealPsbtForWallet,
          finalizePsbtBytes: ownedCommitReveal ?? built.revealPsbt,
          ordinalsAddress: args.parentUtxo.returnAddress,
          // The parent input is a Taproot key-path at the ordinals
          // address; its internal key IS the ordinals x-only pubkey.
          // Address-filter signers need it to shim the correct
          // wallet-side address (see SignChildRevealParentInputsArgs).
          ordinalsPublicKey: hex.encode(args.parentUtxo.utxo.tapInternalKey),
          network: args.network,
          broadcast: args.broadcast,
          promptForSignedPsbt: args.promptForSignedPsbt,
        }).pipe(
          map(({ txId: revealTxId }) => ({
            commitTxId,
            revealTxId,
            childInscriptionId: `${revealTxId}i0`,
            commitAddress: built.commitAddress,
            ephemeral: built.ephemeral,
            fees: built.fees,
          })),
        ),
      ),
    );
  });
}
