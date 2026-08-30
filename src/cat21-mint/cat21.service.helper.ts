import * as btc from '@scure/btc-signer';
import { Network, toScureNetwork } from '../network';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { getMinimumUtxoSize } from '../cat21-script/address-format';
import { buildCat21MintPsbt } from './cat21-mint.helper';
import { prepareMintInputForWallet } from './cat21-mint-input-adapter';
import { CreateTransactionResult, SimulateTransactionResult, TxnOutput } from './cat21.service.types';

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
import { getDummyKeypair, getDummyLegacyTransaction } from '../cat21-fee/dummy-keypair';
export { getDummyKeypair, getDummyLegacyTransaction };

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

/**
 * Dummy-signed simulation of a mint transaction, framework-agnostic. Builds
 * the mint PSBT (via `createTransaction`, simulation mode), dummy-signs input 0
 * with the SDK's well-known key, finalises, and returns the result plus the
 * measured `vsize`. Never broadcast — the fee-estimation path uses it (the
 * Angular `Cat21Service.simulateTransaction` delegates here). Taproot inputs
 * omit `sighashType` (SIGHASH_DEFAULT is wire-equivalent to SIGHASH_ALL for
 * key-path spends per BIP-341), so `[DEFAULT, ALL]` covers both PSBT shapes.
 */
export function simulateMintTransaction(
  walletType: KnownOrdinalWalletType,
  recipientAddress: string,
  paymentOutput: TxnOutput,
  paymentAddress: string,
  paymentPublicKey: Uint8Array,
  transactionFee: bigint,
  network: Network,
): SimulateTransactionResult {
  const { dummyPrivateKey } = getDummyKeypair(toScureNetwork(network));
  const result = createTransaction(
    walletType,
    recipientAddress,
    paymentOutput,
    paymentPublicKey,
    paymentAddress,
    transactionFee,
    true,
    network,
  );
  result.tx.signIdx(dummyPrivateKey, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
  result.tx.finalize();
  return { ...result, vsize: result.tx.vsize };
}
