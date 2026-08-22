import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { getDummyLegacyTransaction } from '../cat21-fee/dummy-keypair';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { Network, toScureNetwork } from '../network';

import { isSegWit } from './address-format';
import { buildInputScript } from './build-input-script';

/**
 * The canonical prepared-PSBT-input shape every CAT-21 Layer-1 builder
 * consumes (mint / transfer / offer / inscribe). scure needs different
 * fields per address type; this carries them all, optionally. The
 * per-domain input types (`Cat21MintFundingInput`,
 * `Cat21TransferCatInput` / `…FundingInput`, `Cat21OfferBuyerInput`,
 * `InscribeFundingInput`) are aliases of this one shape.
 */
export interface Cat21PreparedInput {
  txid: string;
  vout: number;
  /** Sats locked in the UTXO (cat UTXOs are usually 546). */
  value: number;
  /** scriptPubKey bytes. */
  scriptPubKey: Uint8Array;
  /** For taproot inputs, the x-only internal public key (enables key-path signing). */
  tapInternalKey?: Uint8Array;
  /** For P2SH-wrapped SegWit inputs (Xverse Nested SegWit, Unisat-NestedSegWit). */
  redeemScript?: Uint8Array;
  /**
   * For legacy P2PKH inputs (Unisat-Legacy). Full previous-transaction
   * bytes — scure refuses to sign legacy inputs from witnessUtxo alone.
   */
  nonWitnessUtxo?: Uint8Array;
}

export interface PrepareCat21InputArgs {
  utxo: TxnOutput;
  paymentPublicKey: Uint8Array;
  paymentAddress: string;
  isSimulation: boolean;
  network: Network;
}

/**
 * Layer-2 input adapter shared by the mint / transfer / offer / inscribe
 * pipelines: turn a raw funding UTXO (`TxnOutput`) plus the wallet's
 * payment details into the prepared PSBT-input shape the Layer-1
 * builders consume.
 *
 * Address-format-driven via `buildInputScript` — universal dispatch
 * across every wallet the SDK supports. The wallet identity is
 * irrelevant to script construction; only the payment address shape
 * matters. Handles taproot (`tapInternalKey`), P2SH-wrapped SegWit
 * (`redeemScript`), and legacy P2PKH (`nonWitnessUtxo`, since scure
 * refuses witnessUtxo on legacy inputs). Pure function. No I/O, no
 * Angular.
 */
export function prepareCat21Input(args: PrepareCat21InputArgs): Cat21PreparedInput {
  const scureNetwork = toScureNetwork(args.network);

  const { scriptData, tapInternalKey } = buildInputScript({
    paymentAddress: args.paymentAddress,
    paymentPublicKey: args.paymentPublicKey,
    isSimulation: args.isSimulation,
    network: scureNetwork,
  });

  const result: Cat21PreparedInput = {
    txid: args.utxo.txid,
    vout: args.utxo.vout,
    value: args.utxo.value,
    scriptPubKey: scriptData.script,
  };

  if (scriptData.redeemScript) {
    result.redeemScript = scriptData.redeemScript;
  }
  if (tapInternalKey) {
    result.tapInternalKey = tapInternalKey;
  }

  if (!isSegWit(args.paymentAddress)) {
    // Legacy P2PKH path. scure refuses witnessUtxo on legacy inputs;
    // the full previous-tx bytes go via nonWitnessUtxo.
    if (args.isSimulation) {
      const dummyTx = getDummyLegacyTransaction(args.utxo, scureNetwork);
      result.txid = dummyTx.id;
      result.nonWitnessUtxo = hex.decode(dummyTx.hex);
    } else if (args.utxo.transactionHex) {
      result.nonWitnessUtxo = hex.decode(args.utxo.transactionHex);
    } else {
      throw new Error('Missing transaction hex for legacy UTXO input');
    }
  }

  return result;
}

/**
 * Add a prepared cat21 input to `tx` at the given `sequence`, encoding
 * the per-address-type PSBT fields. Shared by the mint / transfer /
 * offer-buyer builders so the input wire-format dispatch lives in one
 * place.
 *
 *   - Legacy P2PKH (`nonWitnessUtxo` set): `nonWitnessUtxo` +
 *     SIGHASH_ALL + optional `redeemScript` (scure refuses witnessUtxo
 *     on legacy inputs).
 *   - SegWit: `witnessUtxo` + optional `redeemScript` (P2SH-wrap) +
 *     optional `tapInternalKey` (Taproot key-path).
 *
 * Taproot inputs OMIT `sighashType`. Per BIP-341 SIGHASH_DEFAULT
 * (absent) and SIGHASH_ALL commit to identical bytes for a key-path
 * spend — only the signature length differs (64 vs 65). Some wallet
 * signers default to DEFAULT for Taproot and a few (Alby's
 * bitcoinjs-lib signer) REJECT an explicit SIGHASH_ALL on Taproot
 * because it requires an `allowedSighashTypes` opt-in the wallet
 * doesn't expose. Omitting the field lets the signer pick its default;
 * the wire commitment is identical.
 */
export function addCat21Input(
  tx: btc.Transaction,
  input: Cat21PreparedInput,
  sequence: number,
): void {
  if (input.nonWitnessUtxo) {
    const legacyInput: btc.TransactionInputUpdate = {
      txid: input.txid,
      index: input.vout,
      sequence,
      sighashType: btc.SigHash.ALL,
      nonWitnessUtxo: input.nonWitnessUtxo,
    };
    if (input.redeemScript) {
      legacyInput.redeemScript = input.redeemScript;
    }
    tx.addInput(legacyInput);
    return;
  }

  const isTaproot = !!input.tapInternalKey;
  const base: btc.TransactionInputUpdate = {
    txid: input.txid,
    index: input.vout,
    sequence,
    witnessUtxo: {
      script: input.scriptPubKey,
      amount: BigInt(input.value),
    },
  };
  if (!isTaproot) {
    base.sighashType = btc.SigHash.ALL;
  }
  if (input.redeemScript) {
    base.redeemScript = input.redeemScript;
  }
  if (input.tapInternalKey) {
    base.tapInternalKey = input.tapInternalKey;
  }
  tx.addInput(base);
}
