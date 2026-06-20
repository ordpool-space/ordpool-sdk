import { Network } from '../network';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
/**
 * Layer-2 input adapter for the CAT-21 inscribe pipeline.
 *
 * Takes a raw funding UTXO (`TxnOutput`) plus the wallet's payment
 * details and produces the funding-input shape that
 * `buildInscribeCommitPsbt` consumes.
 *
 * Address-format-driven via `buildInputScript` — universal dispatch
 * across all wallet variants the SDK supports. Wallet identity is
 * irrelevant; only the payment address shape matters. Mirrors
 * `prepareMintInputForWallet` (the cat21 mint adapter) line-for-line.
 *
 * Pure function. No I/O, no Angular.
 */
export interface InscribeFundingInput {
    txid: string;
    vout: number;
    value: number;
    scriptPubKey: Uint8Array;
    /** Set on P2TR funding inputs (Unisat-Taproot, Xverse-Taproot, etc.). */
    tapInternalKey?: Uint8Array;
    /** Set on P2SH-wrapped funding (Xverse Nested SegWit, Unisat-NestedSegWit). */
    redeemScript?: Uint8Array;
    /** Set on legacy P2PKH funding — scure requires full prev-tx bytes. */
    nonWitnessUtxo?: Uint8Array;
}
export interface PrepareInscribeFundingInputArgs {
    utxo: TxnOutput;
    paymentPublicKey: Uint8Array;
    paymentAddress: string;
    isSimulation: boolean;
    network: Network;
}
export declare function prepareInscribeFundingInput(args: PrepareInscribeFundingInputArgs): InscribeFundingInput;
//# sourceMappingURL=inscription-input-adapter.d.ts.map