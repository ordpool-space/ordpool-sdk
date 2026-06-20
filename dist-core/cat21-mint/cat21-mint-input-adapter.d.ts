import { Network } from '../network';
import { TxnOutput } from './cat21.service.types';
import { Cat21MintFundingInput } from './cat21-mint.helper';
/**
 * Layer-2 input adapter for the CAT-21 mint pipeline.
 *
 * Takes a raw funding UTXO (`TxnOutput`) plus the wallet's payment
 * details and produces the full `Cat21MintFundingInput` shape that
 * `buildCat21MintPsbt` consumes.
 *
 * Address-format-driven via `buildInputScript`. The wallet identity
 * is irrelevant — only the payment address shape matters.
 *
 * Pure function. No I/O, no Angular.
 */
export declare function prepareMintInputForWallet(paymentOutput: TxnOutput, paymentPublicKey: Uint8Array, paymentAddress: string, isSimulation: boolean, network: Network): Cat21MintFundingInput;
//# sourceMappingURL=cat21-mint-input-adapter.d.ts.map