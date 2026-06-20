import { Observable } from 'rxjs';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { Network } from '../network';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { CreateInscribeTransactionsResult } from './inscription.service.helper';
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
    promptForSignedPsbt?(unsigned: {
        base64: string;
        hex: string;
    }): Observable<string>;
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
export declare function inscribeAndBroadcast(args: InscribeAndBroadcastArgs): Observable<InscribeAndBroadcastResult>;
//# sourceMappingURL=inscribe-orchestrator.d.ts.map