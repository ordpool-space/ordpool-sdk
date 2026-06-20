import { Network } from '../network';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { Cat21TransferCatInput, Cat21TransferFundingInput } from './cat21-transfer.types';
/**
 * Layer-2 input adapter for the CAT-21 transfer pipeline.
 *
 * Address-format-driven: dispatches via `buildInputScript`. Works
 * for every wallet — the wallet identity is irrelevant to script
 * construction, only the payment address shape matters.
 *
 * Pure function. No I/O, no Angular.
 */
export interface PrepareTransferInputArgs {
    utxo: TxnOutput;
    paymentPublicKey: Uint8Array;
    paymentAddress: string;
    isSimulation: boolean;
    network: Network;
}
export declare function prepareTransferCatInput(args: PrepareTransferInputArgs): Cat21TransferCatInput;
export declare function prepareTransferFundingInput(args: PrepareTransferInputArgs): Cat21TransferFundingInput;
//# sourceMappingURL=cat21-transfer-input-adapter.d.ts.map