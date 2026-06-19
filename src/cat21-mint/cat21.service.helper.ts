import { Network } from '../network';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { getMinimumUtxoSize } from '../cat21-script/address-format';
import { buildCat21MintPsbt } from './cat21-mint.helper';
import { prepareMintInputForWallet } from './cat21-mint-input-adapter';
import { CreateTransactionResult, TxnOutput } from './cat21.service.types';

// Re-export from the new locations so existing consumers keep working
// while the v2 ecosystem migrates to the canonical import paths.
// Bitcoin / per-wallet script helpers live in `src/cat21-script/`;
// fee-simulation dummy material lives in `src/cat21-fee/`.
export {
  getAddressFormat,
  getMinimumUtxoSize,
  isSegWit,
  toXOnly,
} from '../cat21-script/address-format';
export {
  getDummyKeypair,
  getDummyLegacyTransaction,
} from '../cat21-fee/dummy-keypair';

/**
 * Layer-4 orchestration entry: adapts cat21.space-shaped args to
 * `prepareMintInputForWallet` (Layer 2) + `buildCat21MintPsbt`
 * (Layer 1). One PSBT-assembly path for cat21.space and
 * cat21-wallet's autonomous flow.
 *
 * Change below the per-address-type dust limit is absorbed into
 * the miner fee; above it, a second output is added.
 */
export function createTransaction(
  walletType: KnownOrdinalWalletType,
  recipientAddress: string,
  paymentOutput: TxnOutput,
  paymentPublicKey: Uint8Array,
  paymentAddress: string,
  transactionFee: bigint,
  isSimulation: boolean,
  network: Network,
): CreateTransactionResult {

  const fundingInput = prepareMintInputForWallet(
    paymentOutput,
    paymentPublicKey,
    paymentAddress,
    isSimulation,
    network,
  );

  let built;
  try {
    built = buildCat21MintPsbt({
      walletType,
      network,
      fundingInput,
      destinations: {
        recipientAddress,
        senderChangeAddress: paymentAddress,
      },
      feeSats: Number(transactionFee),
      // cat21.space's per-address-type dust floor (P2TR 330, P2WPKH 294,
      // P2SH 540). Default 546 if not supplied.
      changeDustLimitSats: getMinimumUtxoSize(paymentAddress),
    });
  } catch (err) {
    // The builder throws `Mint funding insufficient: …`; the cat21.space
    // call sites checked the legacy `Insufficient funds for transaction`
    // string. Translate so the UI keeps working.
    if (err instanceof Error && /Mint funding insufficient/.test(err.message)) {
      throw new Error('Insufficient funds for transaction');
    }
    throw err;
  }

  return {
    tx: built.tx,
    amountToRecipient: BigInt(CAT21_POSTAGE_SATS), // always 546
    singleInputAmount: BigInt(paymentOutput.value),
    changeAmount: BigInt(built.changeSats),
    finalTransactionFee: BigInt(built.finalFeeSats),
  };
}
