import { Observable, defer, from, map, of, switchMap, throwError } from 'rxjs';
import type { InscriptionPropertiesInput } from './inscription-properties';
import { hex } from '@scure/base';

import { findSignerOrThrow } from '../wallet/signers';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { Network } from '../network';
import { TxnOutput } from '../cat21-mint/cat21.service.types';

import {
  CreateInscribeTransactionsResult,
  createInscribeTransactions,
} from './inscription.service.helper';
import type { InscriptionContentEncoding } from './inscribe-compression.helper';
import { createBatchChildInscribeTransactions, createBatchInscribeTransactions } from './inscription-batch.helper';
import type {
  BatchParent,
  CreateBatchChildInscribeTransactionsResult,
  CreateBatchInscribeTransactionsArgs,
  CreateBatchInscribeTransactionsResult,
} from './inscription-batch.helper';
import { OrdEnvelopeField } from './inscription-envelope';

/**
 * Public orchestrator for the inscribe operation. Build commit +
 * reveal, ask the user's wallet to sign the commit's funding input
 * via the operation-named `signSingleFundingInput`, broadcast both
 * txs in sequence, return the ephemeral key + txids.
 *
 * # Why one entry point, no signingMap
 *
 * The inscribe commit has a single input at `paymentAddress`,
 * SIGHASH_ALL — same topology as a cat21 mint. The signer's
 * `signSingleFundingInput` enforces that shape; the consumer cannot
 * pass a signingMap that asks for anything else.
 *
 * # Bearer key
 *
 * The ephemeral private key is returned on `result.ephemeral.privKey`.
 * Anyone holding it controls the commit output (redirect, RBF,
 * recover-to-self, bundle) until the commit output is spent. Persist
 * with whatever security posture matches the inscription value;
 * localStorage keyed by `commitTxId` is fine for typical low-value
 * inscriptions, encrypt-at-rest with the wallet password for
 * higher-value flows. See `inscription.service.helper.ts` module
 * doc for the full bearer-key semantic.
 *
 * # Broadcast model
 *
 * Default: sequential. Sign commit → broadcast commit → broadcast
 * reveal. Each broadcast goes through the same `broadcast` callback
 * the consumer supplies (typically `electrs POST /tx`).
 *
 * For atomic submitpackage broadcast, see `broadcastInscribePackage`
 * in `inscribe-broadcast.helper.ts` — the consumer can capture the
 * signed commit hex from this orchestrator's `onCommitSigned`
 * callback and POST both hexes to `/txs/package` instead. The
 * orchestrator itself stays simple.
 */
export interface InscribeAndBroadcastArgs {
  walletType: KnownOrdinalWalletType;
  paymentOutput: TxnOutput;
  paymentPublicKey: Uint8Array;
  paymentAddress: string;
  recipientAddress: string;
  body: Uint8Array;
  contentType?: string;
  envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
  feeRatePerVbyte: number;
  /**
   * Optional tip output appended at vout[1] of the reveal. SDK
   * ships no default address — consumers wire their own. See
   * `createInscribeTransactions` for the full semantic.
   */
  tip?: { address: string; value: number };
  /** Postage for the inscription output, ord's `--postage`. Default 546. */
  postageSats?: number;
  /** Optional Tag::Note (0x0f) watermark string. */
  note?: string;
  /**
   * Optional parent inscription id (`<txid>i<index>`); emits Tag::Parent
   * (0x03). Annotation only — full parent/child provenance also
   * requires spending the parent's UTXO in the reveal (not modelled
   * here). See `createInscribeTransactions` for the caveat.
   */
  parent?: string;
  /**
   * Optional body-encoding hint ('gzip', or 'br' for a caller-supplied
   * brotli body). Body must already be compressed; this flag only emits
   * the envelope tag.
   */
  contentEncoding?: InscriptionContentEncoding;
  /**
   * Optional pointer (tag 0x02) sat offset. Must be < 546 given this
   * builder's single-output reveal topology. See
   * `createInscribeTransactions` for the full caveat.
   */
  pointer?: number;
  /**
   * Optional CBOR metadata (tag 0x05). Pass pre-encoded bytes
   * (`encodeCborDeterministic`); chunked automatically over 520 bytes.
   */
  metadata?: Uint8Array;
  /** Optional metaprotocol identifier (tag 0x07), emitted as UTF-8. */
  metaprotocol?: string;
  /**
   * Optional delegate inscription id (`<txid>i<index>`, tag 0x0b).
   * Functional (no extra tx topology): ord serves the delegate's
   * content. Canonical shape is an empty `body`.
   */
  delegate?: string;
  /**
   * Optional rune-name commitment (tag 0x0d) as the rune's u128 value,
   * emitted as minimal little-endian bytes.
   */
  rune?: bigint;
  /**
   * Optional CBOR properties (tag 0x11): gallery + attributes. Pass
   * pre-encoded bytes (`encodeCborDeterministic`); chunked over 520.
   */
  properties?: Uint8Array;
  /**
   * Gallery, typed: inscription ids or `{ id, title }` items. ord's
   * `--gallery`. Encoded into tag 0x11 exactly as ord does. Mutually
   * exclusive with raw `properties`.
   */
  gallery?: InscriptionPropertiesInput['gallery'];
  /** Title, ord's `--title`. Mutually exclusive with raw `properties`. */
  title?: string;
  /**
   * Inscribe onto the sat at this offset within `paymentOutput`, ord's
   * `--satpoint` (see `CreateInscribeTransactionsArgs.satOffset`).
   */
  satOffset?: number;
  /**
   * Compress `gallery`/`title` as ord's `--compress` does (see
   * `CreateInscribeTransactionsArgs.compressProperties`). Load the brotli
   * wasm first; `compressLikeOrd` on the body does that.
   */
  compressProperties?: boolean;
  /** Optional properties-encoding hint (tag 0x13); only with `properties`. */
  propertyEncoding?: 'br';
  /**
   * How ord tag numbers are pushed into the reveal tapscript. `false`
   * (default) = 2-byte data push, matching ord's own wallet (charm-free).
   * `true` = 1-byte pushnum for tags 1–16, saving a byte per tag at the
   * cost of ord's `vindicated` charm. Everything else identical. See
   * `createInscribeTransactions`.
   */
  minimalTagPush?: boolean;
  network: Network;
  /**
   * Broadcasts a wire-format tx hex; returns the resulting txid.
   * Called twice: once with the wallet-signed commit, then with the
   * ephemeral-key-signed reveal. Same callback for both — the
   * consumer typically wires this to electrs POST /tx.
   */
  broadcast(txHex: string): Observable<string>;
  /**
   * Optional hook fired when the wallet-signed commit hex is in hand,
   * BEFORE broadcast. Useful for consumers that want to swap in a
   * package broadcast or persist the signed bytes for retry.
   */
  onCommitSigned?(signedCommitHex: string): void;
  /**
   * Watch-only signers (psbt-export) bridge to user-mediated signing.
   * Browser-wallet signers ignore it.
   */
  promptForSignedPsbt?(unsigned: { base64: string; hex: string }): Observable<string>;
}

export interface InscribeAndBroadcastResult {
  commitTxId: string;
  revealTxId: string;
  commitAddress: string;
  /** Ephemeral bearer key — persist or forfeit reveal-side flexibility. */
  ephemeral: CreateInscribeTransactionsResult['ephemeral'];
  /** Final commit + reveal fees + vsizes (for UI display). */
  fees: CreateInscribeTransactionsResult['fees'];
}

export function inscribeAndBroadcast(
  args: InscribeAndBroadcastArgs,
): Observable<InscribeAndBroadcastResult> {
  return defer(() => {
    let built: CreateInscribeTransactionsResult;
    try {
      built = createInscribeTransactions({
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
        parent: args.parent,
        contentEncoding: args.contentEncoding,
        pointer: args.pointer,
        metadata: args.metadata,
        metaprotocol: args.metaprotocol,
        delegate: args.delegate,
        rune: args.rune,
        properties: args.properties,
        postageSats: args.postageSats,
        satOffset: args.satOffset,
        gallery: args.gallery,
        title: args.title,
        compressProperties: args.compressProperties,
        propertyEncoding: args.propertyEncoding,
        minimalTagPush: args.minimalTagPush,
        network: args.network,
      });
    } catch (err) {
      return throwError(() => err);
    }

    return signAndBroadcast(built, args);
  });
}

/** The funding, signing and broadcast inputs every inscribe orchestrator shares. */
type SignAndBroadcastArgs = Pick<InscribeAndBroadcastArgs,
  'walletType' | 'paymentPublicKey' | 'paymentAddress' | 'network' | 'broadcast'
  | 'onCommitSigned' | 'promptForSignedPsbt'>;

/**
 * Sign the commit's single funding input, broadcast it, then broadcast the
 * already-signed reveal. The same for one inscription and for a batch: both
 * have one commit input at `paymentAddress`.
 */
function signAndBroadcast(
  built: CreateInscribeTransactionsResult,
  args: SignAndBroadcastArgs,
): Observable<InscribeAndBroadcastResult> {
  const signer = findSignerOrThrow(args.walletType);

  // The signer's broadcast callback is invoked with the signed
  // commit wire-tx hex. We intercept to (a) fire the consumer's
  // onCommitSigned hook, (b) actually broadcast via the consumer's
  // broadcast callback.
  const captureAndBroadcast = (signedCommitHex: string): Observable<string> => {
    if (args.onCommitSigned) {
      try { args.onCommitSigned(signedCommitHex); } catch { /* swallow */ }
    }
    return args.broadcast(signedCommitHex);
  };

  return signer.signSingleFundingInput({
    psbtBytes: built.commitPsbt,
    paymentAddress: args.paymentAddress,
    // Pubkey enables the SDK's wallet-side-address shim so
    // Unisat/Wizz/OKX see their MAINNET address in `toSignInputs`
    // even when the app carries a bcrt address on regtest. Native-
    // regtest wallets (Xverse/Cat21/Alby) get the app address
    // unchanged. See src/wallet/network-address-shim.ts.
    paymentPublicKey: hex.encode(args.paymentPublicKey),
    network: args.network,
    broadcast: captureAndBroadcast,
    promptForSignedPsbt: args.promptForSignedPsbt,
  }).pipe(
    switchMap(({ txId: commitTxId }) =>
      args.broadcast(built.revealHex).pipe(
        map((revealTxId) => ({
          commitTxId,
          revealTxId,
          commitAddress: built.commitAddress,
          ephemeral: built.ephemeral,
          fees: built.fees,
        })),
      ),
    ),
  );
}

/** Args for {@link inscribeBatchAndBroadcast}: the batch builder's inputs plus signing and broadcast. */
export interface InscribeBatchAndBroadcastArgs
  extends Omit<CreateBatchInscribeTransactionsArgs, 'walletType'>, SignAndBroadcastArgs {
  /**
   * ord's batch `parents`. The reveal spends them, so the connected wallet
   * signs them after the commit (`signChildRevealParentInputs`). They must
   * all sit at one ordinals address, the wallet's, where they return.
   */
  parents?: ReadonlyArray<BatchParent>;
}

export interface InscribeBatchAndBroadcastResult extends InscribeAndBroadcastResult {
  /** Where each inscription lands; inscription i is `<revealTxId>i<i>`. */
  inscriptions: CreateBatchInscribeTransactionsResult['inscriptions'];
}

/**
 * Public orchestrator for a batch inscribe (`ord wallet batch`): build the
 * batch commit and reveal, have the wallet sign the commit's single funding
 * input via `signSingleFundingInput`, broadcast commit then reveal. Same
 * signing topology, bearer-key semantics and broadcast model as
 * {@link inscribeAndBroadcast}.
 */
export function inscribeBatchAndBroadcast(
  args: InscribeBatchAndBroadcastArgs,
): Observable<InscribeBatchAndBroadcastResult> {
  if (args.parents !== undefined && args.parents.length > 0) {
    return inscribeBatchWithParents({ ...args, parents: args.parents });
  }
  return defer(() => {
    let built: CreateBatchInscribeTransactionsResult;
    try {
      built = createBatchInscribeTransactions(args);
    } catch (err) {
      return throwError(() => err);
    }
    return signAndBroadcast(built, args).pipe(
      map((result) => ({ ...result, inscriptions: built.inscriptions })),
    );
  });
}

/**
 * The batch-with-parents path: sign and broadcast the commit, then have the
 * wallet sign the reveal's parent inputs 0..N-1 on the bare reveal PSBT;
 * those signatures are merged into the full reveal, which then broadcasts.
 */
function inscribeBatchWithParents(
  args: InscribeBatchAndBroadcastArgs & { parents: ReadonlyArray<BatchParent> },
): Observable<InscribeBatchAndBroadcastResult> {
  return defer(() => {
    const [first] = args.parents;
    const sameOwner = args.parents.every(p =>
      p.returnAddress === first.returnAddress
      && hex.encode(p.utxo.tapInternalKey) === hex.encode(first.utxo.tapInternalKey));
    if (!sameOwner) {
      return throwError(() => new Error(
        'every parent must sit at the same ordinals address (the connected wallet signs them there)',
      ));
    }
    let built: CreateBatchChildInscribeTransactionsResult;
    try {
      built = createBatchChildInscribeTransactions(args);
    } catch (err) {
      return throwError(() => err);
    }

    const signer = findSignerOrThrow(args.walletType);
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
          psbtBytes: built.revealPsbtForWallet,
          finalizePsbtBytes: built.revealPsbt,
          ordinalsAddress: first.returnAddress,
          // Each parent is a Taproot key-path at the ordinals address; its
          // internal key IS the ordinals x-only pubkey.
          ordinalsPublicKey: hex.encode(first.utxo.tapInternalKey),
          parentCount: args.parents.length,
          network: args.network,
          broadcast: args.broadcast,
          promptForSignedPsbt: args.promptForSignedPsbt,
        }).pipe(
          map(({ txId: revealTxId }) => ({
            commitTxId,
            revealTxId,
            commitAddress: built.commitAddress,
            ephemeral: built.ephemeral,
            fees: built.fees,
            inscriptions: built.inscriptions,
          })),
        ),
      ),
    );
  });
}
