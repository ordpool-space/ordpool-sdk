import { Observable, defer, map, switchMap, throwError } from 'rxjs';
import { hex } from '@scure/base';

import { findSignerOrThrow } from '../wallet/signers/index.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import { Network } from '../network.js';
import { TxnOutput } from '../cat21-mint/cat21.service.types.js';

import {
  CreateChildInscribeTransactionsResult,
  createChildInscribeTransactions,
} from './inscription.service.helper.js';
import { ChildRevealParent } from './inscription-child-reveal.helper.js';
import { OrdEnvelopeField } from './inscription-envelope.js';
import type { InscriptionContentEncoding } from './inscribe-compression.helper.js';
import type { InscribeBroadcastTransport } from './inscribe-package-broadcast.js';
import { holdSigned, sendPair } from './inscribe-signed-pair.js';

/**
 * Public orchestrator for the ord parent/child (provenance) inscribe.
 * Composes builder + signer + broadcast for Path 2/3:
 *
 *   1. `createChildInscribeTransactions` — commit PSBT + a CHILD reveal
 *      PSBT (parent input unsigned, commit input ephemeral-finalized).
 *   2. `signSingleFundingInput` — the wallet signs the commit's funding
 *      input. Nothing is sent yet.
 *   3. `signChildRevealParentInputs` — the wallet signs the reveal's
 *      PARENT input (index 0, the ordinals key that owns the parent);
 *      the commit input (index 1) is already witnessed.
 *   4. `broadcastCommitAndReveal` — validate the pair, then send it as a
 *      package. Cancelling step 3 therefore leaves nothing on the network.
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
  /** Where the signed pair goes; see `InscribeAndBroadcastArgs.transport`. */
  transport: InscribeBroadcastTransport;
  /** Fired with the wallet-signed commit hex, before anything is sent. */
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
        network: args.network,
      });
    } catch (err) {
      return throwError(() => err);
    }

    const signer = findSignerOrThrow(args.walletType);
    const commit = holdSigned(args.onCommitSigned);
    const reveal = holdSigned();

    return signer.signSingleFundingInput({
      psbtBytes: built.commitPsbt,
      paymentAddress: args.paymentAddress,
      paymentPublicKey: hex.encode(args.paymentPublicKey),
      network: args.network,
      broadcast: commit.broadcast,
      promptForSignedPsbt: args.promptForSignedPsbt,
    }).pipe(
      switchMap(() =>
        signer.signChildRevealParentInputs({
          // Wallet signs input 0 on the BARE PSBT (no envelope tap-leaf);
          // its signature is merged into the full PSBT to finalize.
          psbtBytes: built.revealPsbtForWallet,
          finalizePsbtBytes: built.revealPsbt,
          ordinalsAddress: args.parentUtxo.returnAddress,
          // The parent input is a Taproot key-path at the ordinals
          // address; its internal key IS the ordinals x-only pubkey.
          // Address-filter signers need it to shim the correct
          // wallet-side address (see SignChildRevealParentInputsArgs).
          ordinalsPublicKey: hex.encode(args.parentUtxo.utxo.tapInternalKey),
          network: args.network,
          broadcast: reveal.broadcast,
          promptForSignedPsbt: args.promptForSignedPsbt,
        }),
      ),
      switchMap(() => sendPair(args.transport, built, commit.take(), reveal.take())),
      map((result) => ({ ...result, childInscriptionId: `${result.revealTxId}i0` })),
    );
  });
}
