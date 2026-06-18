import { hex } from '@scure/base';

import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { buildInputScript } from '../cat21-script/build-input-script';
import { isSegWit } from '../cat21-script/address-format';
import { getDummyLegacyTransaction } from '../cat21-fee/dummy-keypair';
import { TxnOutput } from './cat21.service.types';
import { Cat21MintFundingInput } from './cat21-mint.helper';

/**
 * Layer-2 input adapter for the CAT-21 mint pipeline.
 *
 * Takes a raw funding UTXO (`TxnOutput`) plus the wallet's payment
 * details and produces the full `Cat21MintFundingInput` shape that
 * `buildCat21MintPsbt` consumes.
 *
 * Dispatch is now PURELY address-format-driven via `buildInputScript`
 * — the `walletType` argument is retained ONLY for orchestration
 * concerns the SDK still needs (sequence-number rule, signing-flow
 * routing in the higher layers). The script-construction decision
 * does NOT look at it.
 *
 * Net effect: every wallet in `KnownOrdinalWalletType` — including
 * the six (oyl, wizz, okx, phantom, alby, binance) that previously
 * hit `default → throw 'Unknown wallet'` — now produces a correct
 * script. The byte-shape gate is the 12 per-wallet snapshots in
 * `cat21.service.helper.spec.ts.snap`: if they stay green after the
 * migration, the address-format-driven path is byte-identical to the
 * old per-wallet switch for Leather / Xverse / Unisat.
 *
 * Pure function. No I/O, no Angular.
 */
export function prepareMintInputForWallet(
  walletType: KnownOrdinalWalletType,
  paymentOutput: TxnOutput,
  paymentPublicKey: Uint8Array,
  paymentAddress: string,
  isSimulation: boolean,
  network: Network,
): Cat21MintFundingInput {
  // walletType is unused for script construction — kept in the
  // signature because higher layers (sequence rule, orchestrators)
  // still need it. The `void` reference silences unused-parameter
  // warnings without lying about the signature.
  void walletType;

  const scureNetwork = toScureNetwork(network);

  const { scriptData, tapInternalKey } = buildInputScript({
    paymentAddress,
    paymentPublicKey,
    isSimulation,
    network: scureNetwork,
  });

  const result: Cat21MintFundingInput = {
    txid: paymentOutput.txid,
    vout: paymentOutput.vout,
    value: paymentOutput.value,
    scriptPubKey: scriptData.script,
  };

  if (scriptData.redeemScript) {
    result.redeemScript = scriptData.redeemScript;
  }

  if (tapInternalKey) {
    result.tapInternalKey = tapInternalKey;
  }

  if (!isSegWit(paymentAddress)) {
    // Legacy P2PKH path. Scure refuses witnessUtxo on legacy inputs;
    // the full previous-tx bytes go via nonWitnessUtxo.
    if (isSimulation) {
      const dummyTx = getDummyLegacyTransaction(paymentOutput, scureNetwork);
      result.txid = dummyTx.id;
      result.nonWitnessUtxo = hex.decode(dummyTx.hex);
    } else if (paymentOutput.transactionHex) {
      result.nonWitnessUtxo = hex.decode(paymentOutput.transactionHex);
    } else {
      throw new Error('Missing transaction hex for legacy UTXO input');
    }
  }

  return result;
}
