import { Observable, defer, from, map, of, switchMap, throwError } from 'rxjs';
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
        propertyEncoding: args.propertyEncoding,
        minimalTagPush: args.minimalTagPush,
        network: args.network,
      });
    } catch (err) {
      return throwError(() => err);
    }

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
  });
}
