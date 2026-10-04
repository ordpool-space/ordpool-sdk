import { Observable, defer, from, map, of, switchMap, throwError } from 'rxjs';
import type { InscriptionPropertiesInput } from './inscription-properties.js';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { findSignerOrThrow } from '../wallet/signers/index.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import { Network, toScureNetwork } from '../network.js';
import { TxnOutput } from '../cat21-mint/cat21.service.types.js';

import {
  CreateInscribeTransactionsResult,
  createInscribeTransactions,
} from './inscription.service.helper.js';
import type { InscriptionContentEncoding } from './inscribe-compression.helper.js';
import type { InscribeSatSource } from './inscription-commit.helper.js';
import { createBatchChildInscribeTransactions, createBatchInscribeTransactions } from './inscription-batch.helper.js';
import type {
  BatchParent,
  CreateBatchChildInscribeTransactionsResult,
  CreateBatchInscribeTransactionsArgs,
  CreateBatchInscribeTransactionsResult,
} from './inscription-batch.helper.js';
import { OrdEnvelopeField } from './inscription-envelope.js';
import type { InscribeBroadcastTransport } from './inscribe-package-broadcast.js';
import { holdSigned, sendPair } from './inscribe-signed-pair.js';

/**
 * Public orchestrator for the inscribe operation. Build commit +
 * reveal, ask the user's wallet to sign the commit's funding input
 * via the operation-named `signSingleFundingInput`, then send both
 * txs together, return the ephemeral key + txids.
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
 * Every signature is collected first: the signers' `broadcast` callback
 * only keeps the signed bytes. Nothing is sent until the commit AND the
 * reveal are signed, and then `broadcastCommitAndReveal` validates the
 * pair with `testmempoolaccept` before submitting it as a package. A
 * commit can therefore never go out ahead of a reveal that is refused,
 * or ahead of a second wallet prompt the user cancels.
 * See `inscribe-package-broadcast.ts`.
 */
export interface InscribeAndBroadcastArgs {
  walletType: KnownOrdinalWalletType;
  paymentOutput: TxnOutput;
  paymentPublicKey: Uint8Array;
  paymentAddress: string;
  recipientAddress: string;
  /** Body bytes. Omit for a delegate-only inscription (needs `delegate`). */
  body?: Uint8Array;
  contentType?: string;
  envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
  feeRatePerVbyte: number;
  /** sat/vB fee rate of the commit, ord's `--commit-fee-rate`. Default `feeRatePerVbyte`. */
  commitFeeRatePerVbyte?: number;
  /** Allow a reveal above `MAX_STANDARD_TX_WEIGHT`, ord's `--no-limit`. */
  noLimit?: boolean;
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
  /** Traits, in order (a batchfile's `traits:`). Mutually exclusive with raw `properties`. */
  traits?: InscriptionPropertiesInput['traits'];
  /**
   * Inscribe onto the sat at this offset within `paymentOutput`, ord's
   * `--satpoint` (see `CreateInscribeTransactionsArgs.satOffset`).
   */
  satOffset?: number;
  /**
   * Inscribe onto a sat in a UTXO other than `paymentOutput`, e.g. a rare
   * sat at the ordinals address (see `CreateInscribeTransactionsArgs.satSource`).
   * The wallet then signs the commit with the transfer topology: input 0 at
   * the ordinals address, the funding at input 1.
   */
  satSource?: InscribeSatSource;
  /**
   * A second payment UTXO for a chosen sat less than a dust limit into its
   * UTXO (see `CreateInscribeTransactionsArgs.paddingUtxo`). The wallet then
   * signs the commit through `signPaddedSatCommit`.
   */
  paddingUtxo?: TxnOutput;
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
   * Where the signed pair goes. Required: there is no sequential
   * fallback, because sending the commit alone is how funds get stuck.
   * Usually `esploraInscribeTransport([<your electrs /api base>])`.
   */
  transport: InscribeBroadcastTransport;
  /**
   * Optional hook fired when the wallet-signed commit hex is in hand,
   * before anything is sent (for example to advance a "step 2 of 2"
   * indicator). It cannot change the flow.
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
        commitFeeRatePerVbyte: args.commitFeeRatePerVbyte,
        noLimit: args.noLimit,
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
        satSource: args.satSource,
        paddingUtxo: args.paddingUtxo,
        gallery: args.gallery,
        title: args.title,
        traits: args.traits,
        compressProperties: args.compressProperties,
        propertyEncoding: args.propertyEncoding,
        minimalTagPush: args.minimalTagPush,
        network: args.network,
      });
    } catch (err) {
      return throwError(() => err);
    }

    if (args.satSource !== undefined || args.paddingUtxo !== undefined) {
      return signMultiInputCommitAndBroadcast(built, args);
    }
    return signAndBroadcast(built, args);
  });
}

/**
 * The commits that carry more than the one funding input: a satSource ahead
 * of the funding input (the transfer topology: input 0 at the ordinals
 * address, the funding at 1, signed through `signTransfer`), and a padding
 * input in front of a sub-dust padding output (`signPaddedSatCommit`). The
 * signer derives the indexes from the method; then the pre-signed reveal
 * broadcasts.
 */
function signMultiInputCommitAndBroadcast(
  built: CreateInscribeTransactionsResult,
  args: SignAndBroadcastArgs & { satSource?: InscribeSatSource; paddingUtxo?: TxnOutput },
): Observable<InscribeAndBroadcastResult> {
  const signer = findSignerOrThrow(args.walletType);
  const commit = holdSigned(args.onCommitSigned);
  const signedCommit = args.paddingUtxo !== undefined
    ? signer.signPaddedSatCommit({
      psbtBytes: built.commitPsbt,
      paymentAddress: args.paymentAddress,
      ordinalsAddress: args.satSource?.address,
      network: args.network,
      broadcast: commit.broadcast,
      promptForSignedPsbt: args.promptForSignedPsbt,
    })
    : signer.signTransfer({
      psbtBytes: built.commitPsbt,
      ordinalsAddress: (args.satSource as InscribeSatSource).address,
      paymentAddress: args.paymentAddress,
      fundingInputCount: 1,
      network: args.network,
      broadcast: commit.broadcast,
      promptForSignedPsbt: args.promptForSignedPsbt,
    });
  return signedCommit.pipe(
    switchMap(() => sendPair(args.transport, built, commit.take(), built.revealHex)),
  );
}

/** The funding, signing and broadcast inputs every inscribe orchestrator shares. */
type SignAndBroadcastArgs = Pick<InscribeAndBroadcastArgs,
  'walletType' | 'paymentPublicKey' | 'paymentAddress' | 'network' | 'transport'
  | 'onCommitSigned' | 'promptForSignedPsbt'>;

/**
 * Sign the commit's single funding input, then send it together with the
 * already-signed reveal. The same for one inscription and for a batch: both
 * have one commit input at `paymentAddress`.
 */
function signAndBroadcast(
  built: CreateInscribeTransactionsResult,
  args: SignAndBroadcastArgs,
): Observable<InscribeAndBroadcastResult> {
  const signer = findSignerOrThrow(args.walletType);
  const commit = holdSigned(args.onCommitSigned);

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
    broadcast: commit.broadcast,
    promptForSignedPsbt: args.promptForSignedPsbt,
  }).pipe(
    switchMap(() => sendPair(args.transport, built, commit.take(), built.revealHex)),
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
 * input via `signSingleFundingInput`, send commit and reveal together. Same
 * signing topology, bearer-key semantics and broadcast model as
 * {@link inscribeAndBroadcast}.
 */
export function inscribeBatchAndBroadcast(
  args: InscribeBatchAndBroadcastArgs,
): Observable<InscribeBatchAndBroadcastResult> {
  if ((args.parents !== undefined && args.parents.length > 0) || args.mode === 'satpoints') {
    return inscribeBatchWithWalletInputs({ ...args, parents: args.parents ?? [] });
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
 * The path for a batch whose reveal spends wallet UTXOs (parents, satpoint
 * UTXOs): sign the commit, then have the wallet sign those reveal inputs
 * 0..N-1 on the bare reveal PSBT; the signatures are merged into the full
 * reveal. Only then are both sent, so cancelling the second prompt leaves
 * nothing on the network.
 */
function inscribeBatchWithWalletInputs(
  args: InscribeBatchAndBroadcastArgs & { parents: ReadonlyArray<BatchParent> },
): Observable<InscribeBatchAndBroadcastResult> {
  return defer(() => {
    // The wallet signs every one of these inputs at one ordinals address.
    const walletUtxos = [
      ...args.parents.map(p => p.utxo),
      ...(args.mode === 'satpoints' ? args.inscriptions.flatMap(e => (e.satpoint ? [e.satpoint] : [])) : []),
    ];
    if (walletUtxos.length === 0) {
      return throwError(() => new Error('a satpoints batch needs a satpoint for every inscription'));
    }
    const [first] = walletUtxos;
    const sameOwner = walletUtxos.every(u =>
      hex.encode(u.scriptPubKey) === hex.encode(first.scriptPubKey)
      && hex.encode(u.tapInternalKey) === hex.encode(first.tapInternalKey));
    if (!sameOwner) {
      return throwError(() => new Error(
        'every parent and satpoint UTXO must sit at the same ordinals address (the connected wallet signs them there)',
      ));
    }
    const ordinalsAddress = btc.Address(toScureNetwork(args.network)).encode(btc.OutScript.decode(first.scriptPubKey));
    let built: CreateBatchChildInscribeTransactionsResult;
    try {
      built = createBatchChildInscribeTransactions(args);
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
          psbtBytes: built.revealPsbtForWallet,
          finalizePsbtBytes: built.revealPsbt,
          ordinalsAddress,
          // Each wallet input is a Taproot key-path at the ordinals address;
          // its internal key IS the ordinals x-only pubkey.
          ordinalsPublicKey: hex.encode(first.tapInternalKey),
          walletInputCount: built.walletInputCount,
          network: args.network,
          broadcast: reveal.broadcast,
          promptForSignedPsbt: args.promptForSignedPsbt,
        }),
      ),
      switchMap(() => sendPair(args.transport, built, commit.take(), reveal.take())),
      map((result) => ({ ...result, inscriptions: built.inscriptions })),
    );
  });
}
