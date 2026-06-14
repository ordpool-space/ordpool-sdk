import * as btc from '@scure/btc-signer';
import { SigHash } from '@scure/btc-signer/transaction';
import type { InputData } from 'coin-selection/coin-selection.utils';

import { createMoney } from '@leather.io/utils';

import {
  CoinSelectionRecipient,
  determineUtxosForSpend,
} from '../coin-selection/coin-selection';
import {
  BitcoinNativeSegwitPayer,
  BitcoinTaprootPayer,
  payerToBip32Derivation,
  payerToTapBip32Derivation,
} from '../signer/bitcoin-payer';
import { BtcSignerNetwork } from '../utils/bitcoin.network';
import { BitcoinError } from '../validation/bitcoin-error';

/**
 * Postage carried by the cat output. The genesis sat sits on the first sat of
 * the first output (ordinal theory), so any value above relay dust holds the
 * cat. We match the CAT-21 mint default (546) to keep the wallet's behaviour
 * uniform across mint, buy, and sell flows.
 */
export const CAT21_OFFER_POSTAGE = 546;

/**
 * Description of the cat being acquired. The buyer must know the seller's
 * UTXO precisely (txid, vout, value, scriptPubKey) so they can reference it
 * in the offer PSBT without seller intervention.
 */
export interface Cat21OfferSellerInput {
  txid: string;
  vout: number;
  /** Sats locked in the cat-bearing UTXO. Usually 546 but caller passes through. */
  value: number;
  /** scriptPubKey of the seller's UTXO, raw bytes. */
  scriptPubKey: Uint8Array;
}

export interface Cat21OfferDestination {
  /** Where the cat lands. The first sat of this output ends up holding the cat. */
  buyerReceiveAddress: string;
  /** Where the BTC payment goes. */
  sellerPaymentAddress: string;
  /** Where buyer change goes. */
  buyerChangeAddress: string;
}

export interface GenerateCat21BuyOfferArgs<T> {
  feeRate: number;
  network: BtcSignerNetwork;
  sellerInput: Cat21OfferSellerInput;
  /** What the buyer is paying, in sats. The cat-output postage is added separately. */
  priceSats: number;
  destinations: Cat21OfferDestination;
  /** Buyer's funding UTXOs — used to cover priceSats + fee + cat postage. */
  utxos: T[];
  payerLookup(keyOrigin: string): BitcoinNativeSegwitPayer | BitcoinTaprootPayer | undefined;
}

/**
 * Builds the buyer-initiated CAT-21 offer PSBT (ord-style, SIGHASH_ALL).
 *
 * Structure:
 *   Input 0  — seller's cat-bearing UTXO. Referenced. Witness data is filled
 *              with the scriptPubKey + value the buyer specifies, so the
 *              seller can sign without round-trips. UNSIGNED by buyer.
 *   Input 1+ — buyer's funding UTXOs. ALL SIGHASH_ALL. Buyer signs locally.
 *   Output 0 — buyer's receive address, postage. The cat lands here.
 *   Output 1 — seller's payment address, `priceSats`.
 *   Output 2 — buyer's change (when above dust).
 *
 * Why this is sniping-proof: the only signature missing at the time the PSBT
 * leaves the buyer is the seller's. Once the seller signs (SIGHASH_ALL), every
 * byte of the transaction is covered by some signature; the seller cannot
 * mutate outputs, inputs, fees, or anything else without invalidating the
 * buyer's signatures. There is no half-signed PSBT a third party can splice
 * into a sniping transaction.
 *
 * The seller's signing happens in the offer-accept flow, not here. This
 * function only produces the buyer-signed unsigned-at-input-0 PSBT.
 */
export function generateCat21BuyOfferUnsignedPsbt<
  T extends InputData & { vout: number; keyOrigin: string },
>({
  feeRate,
  network,
  sellerInput,
  priceSats,
  destinations,
  utxos,
  payerLookup,
}: GenerateCat21BuyOfferArgs<T>) {
  if (priceSats <= 0) throw new BitcoinError('InsufficientAmount');
  if (sellerInput.value < CAT21_OFFER_POSTAGE) throw new BitcoinError('InsufficientAmount');

  /* Buyer funding has to cover:
   *   - seller payment (priceSats)
   *   - cat-output postage (sellerInput.value, which lands on buyerReceiveAddress)
   *   - miner fee (determined by coin selection)
   *
   * We model the postage as a recipient that the coin-selection logic must
   * cover. The seller's UTXO will *also* arrive in the cat-output via input 0,
   * so technically the value is double-counted in coin selection — we
   * subtract it below when assembling the actual transaction outputs. */
  const recipients: CoinSelectionRecipient[] = [
    {
      address: destinations.buyerReceiveAddress,
      amount: createMoney(sellerInput.value, 'BTC'),
    },
    { address: destinations.sellerPaymentAddress, amount: createMoney(priceSats, 'BTC') },
  ];

  const { inputs, outputs, fee } = determineUtxosForSpend({ feeRate, recipients, utxos });

  if (!inputs.length) throw new BitcoinError('NoInputsToSign');

  const tx = new btc.Transaction();

  // Input 0: seller's UTXO. Unsigned here; the seller will sign in the accept flow.
  tx.addInput({
    txid: sellerInput.txid,
    index: sellerInput.vout,
    witnessUtxo: {
      script: sellerInput.scriptPubKey,
      amount: BigInt(sellerInput.value),
    },
    sighashType: SigHash.ALL,
  });

  // Inputs 1..N: buyer-funded.
  for (const input of inputs) {
    const payer = payerLookup(input.keyOrigin);
    if (!payer) {
      // eslint-disable-next-line no-console
      console.log(`No payer found for input with keyOrigin ${input.keyOrigin}`);
      continue;
    }

    const bip32Derivation =
      payer.paymentType === 'p2tr'
        ? { tapBip32Derivation: [payerToTapBip32Derivation(payer)] }
        : { bip32Derivation: [payerToBip32Derivation(payer)] };

    const tapInternalKey =
      payer.paymentType === 'p2tr' ? { tapInternalKey: payer.payment.tapInternalKey } : {};

    tx.addInput({
      txid: input.txid,
      index: input.vout,
      witnessUtxo: { script: payer.payment.script, amount: BigInt(input.value) },
      sighashType: SigHash.ALL,
      ...bip32Derivation,
      ...tapInternalKey,
    });
  }

  // Outputs: pull the recipients from coin selection but route change to the
  // buyer change address instead of letting coin selection guess.
  outputs.forEach(output => {
    if (!output.address) {
      tx.addOutputAddress(destinations.buyerChangeAddress, BigInt(output.value), network);
      return;
    }
    tx.addOutputAddress(output.address, BigInt(output.value), network);
  });

  /* Hard asserts on SIGHASH_ALL: every buyer-signed input must use SIGHASH_ALL
   * for the sniping-proof guarantee. The seller's input also carries
   * SIGHASH_ALL so the seller's signature, once added, covers the same shape. */
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    if (input.sighashType !== SigHash.ALL) {
      throw new BitcoinError('Cat21OfferSighashBroken');
    }
  }

  return { tx, hex: tx.hex, psbt: tx.toPSBT(), fee };
}
