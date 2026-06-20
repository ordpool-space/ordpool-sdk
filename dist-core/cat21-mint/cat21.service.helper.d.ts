import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { CreateTransactionResult, TxnOutput } from './cat21.service.types';
export { getAddressFormat, getMinimumUtxoSize, isSegWit, toXOnly, } from '../cat21-script/address-format';
export { getDummyKeypair, getDummyLegacyTransaction, } from '../cat21-fee/dummy-keypair';
/**
 * Layer-4 orchestration entry: adapts cat21.space-shaped args to
 * `prepareMintInputForWallet` (Layer 2) + `buildCat21MintPsbt`
 * (Layer 1). One PSBT-assembly path for cat21.space and
 * cat21-wallet's autonomous flow.
 *
 * Change below the per-address-type dust limit is absorbed into
 * the miner fee; above it, a second output is added.
 */
export declare function createTransaction(walletType: KnownOrdinalWalletType, recipientAddress: string, paymentOutput: TxnOutput, paymentPublicKey: Uint8Array, paymentAddress: string, transactionFee: bigint, isSimulation: boolean, network: Network): CreateTransactionResult;
//# sourceMappingURL=cat21.service.helper.d.ts.map