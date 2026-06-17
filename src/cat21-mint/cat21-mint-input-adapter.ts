import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';

import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  createInputScriptForLeather,
  createInputScriptForUnisat,
  createInputScriptForXverse,
} from '../cat21-script/per-wallet-scripts';
import {
  getAddressFormat,
  isSegWit,
  toXOnly,
} from '../cat21-script/address-format';
import {
  getDummyKeypair,
  getDummyLegacyTransaction,
} from '../cat21-fee/dummy-keypair';
import { TxnOutput } from './cat21.service.types';
import { Cat21MintFundingInput } from './cat21-mint.helper';

/**
 * Layer-2 input adapter for the CAT-21 mint pipeline.
 *
 * Takes a raw funding UTXO (`TxnOutput`) plus the wallet's payment
 * details and produces the full `Cat21MintFundingInput` shape that
 * `buildCat21MintPsbt` consumes. Handles every wallet variant the SDK
 * speaks today:
 *
 *   | Wallet              | Address shape   | Adapter output         |
 *   |---------------------|-----------------|------------------------|
 *   | Leather             | P2WPKH          | scriptPubKey only      |
 *   | CAT-21 wallet       | P2WPKH (BIP-84) | scriptPubKey only      |
 *   | Xverse              | P2SH-P2WPKH     | scriptPubKey + redeemScript |
 *   | Unisat — SegWit     | P2WPKH          | scriptPubKey only      |
 *   | Unisat — Taproot    | P2TR key-path   | scriptPubKey + tapInternalKey |
 *   | Unisat — Legacy     | P2PKH           | scriptPubKey + nonWitnessUtxo |
 *
 * `isSimulation = true` swaps the real pubkey for the SDK's well-known
 * dummy key — used by the fee-simulation pass to compute vsize without
 * exposing the user's key material.
 *
 * Pure function. No I/O, no side effects, no Angular. The wallet-side
 * (cat21-wallet React + Webpack background) AND the cat21.space Angular
 * orchestrator both call this adapter and feed the result into the same
 * `buildCat21MintPsbt`. ONE PSBT builder, ONE input shape, MULTIPLE
 * adapters per consumer flavor.
 */
export function prepareMintInputForWallet(
  walletType: KnownOrdinalWalletType,
  paymentOutput: TxnOutput,
  paymentPublicKey: Uint8Array,
  paymentAddress: string,
  isSimulation: boolean,
  network: Network,
): Cat21MintFundingInput {
  const scureNetwork = toScureNetwork(network);

  let paymentPublicKeyToUse = paymentPublicKey;
  if (isSimulation) {
    paymentPublicKeyToUse = getDummyKeypair(scureNetwork).dummyPublicKey;
  }

  let scriptData: btc.P2Ret | btc.P2TROut;
  let tapInternalKey: Uint8Array | undefined;

  switch (walletType) {
    case KnownOrdinalWalletType.leather:
    case KnownOrdinalWalletType.cat21wallet: {
      // CAT-21 wallet is forked from Leather and inherits its BIP-84
      // P2WPKH payment-address derivation. Same script shape.
      scriptData = createInputScriptForLeather(paymentPublicKeyToUse, scureNetwork);
      break;
    }
    case KnownOrdinalWalletType.xverse: {
      scriptData = createInputScriptForXverse(paymentAddress, paymentPublicKeyToUse, scureNetwork);
      break;
    }
    case KnownOrdinalWalletType.unisat: {
      // Taproot uses x-only pubkey, swap accordingly before constructing script.
      if (getAddressFormat(paymentAddress) === 'P2TR') {
        if (isSimulation) {
          paymentPublicKeyToUse = getDummyKeypair(scureNetwork).xOnlyDummyPublicKey;
        } else {
          paymentPublicKeyToUse = toXOnly(paymentPublicKey);
        }
        tapInternalKey = paymentPublicKeyToUse;
      }
      scriptData = createInputScriptForUnisat(paymentAddress, paymentPublicKeyToUse, scureNetwork);
      break;
    }
    default:
      // This case should never happen, but otherwise the code is not type-safe.
      throw new Error('Unknown wallet');
  }

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
    // Legacy P2PKH path. scure refuses to sign legacy inputs from
    // witnessUtxo alone — it wants the full previous-tx bytes via
    // nonWitnessUtxo (see paulmillr/scure-btc-signer README).
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
