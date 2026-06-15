import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network';
import {
  CAT21_OFFER_POSTAGE_SATS,
  Cat21OfferBuyerInput,
  Cat21OfferDestinations,
  Cat21OfferRejectionReason,
  Cat21OfferSellerInput,
  Cat21OfferValidation,
} from './cat21-offer.types';

/**
 * Arguments for `buildCat21BuyOfferPsbt`.
 *
 * The caller is responsible for coin selection (the SDK exposes coin-selection
 * helpers in `cat21-mint`; reuse them). This function only structures the PSBT
 * and validates the SIGHASH invariant; it does not pick UTXOs, fetch them, or
 * compute fees.
 */
export interface BuildCat21BuyOfferArgs {
  network: Network;
  sellerInput: Cat21OfferSellerInput;
  buyerInputs: Cat21OfferBuyerInput[];
  destinations: Cat21OfferDestinations;
  /** Sats paid to the seller. Does NOT include postage; postage is separate. */
  priceSats: number;
  /** Optional override for the cat-output postage. Defaults to 546. */
  postageSats?: number;
  /**
   * Miner fee in sats. Caller computes this from the chosen feeRate and the
   * estimated tx size (use `getBitcoinTransactionFee` from `cat21-mint` or any
   * equivalent). The builder does not compute fees because the buyer-funded
   * UTXOs may live in two different script types and only the caller knows
   * the correct size estimator.
   */
  feeSats: number;
}

export interface BuildCat21BuyOfferResult {
  /** Raw hex of the unsigned tx (input 0 carries no buyer signature). */
  hex: string;
  /** Raw PSBT bytes. */
  psbt: Uint8Array;
  /** Total buyer-funded input value (sum of buyerInputs.value). */
  buyerInputTotalSats: number;
  /** Change output value (may be 0 when sub-dust; absorbed into fee). */
  changeSats: number;
}

/**
 * Builds the buyer-initiated CAT-21 offer PSBT (ord-style, SIGHASH_ALL on
 * every input).
 *
 * Structure:
 *   Input 0  — seller's cat-bearing UTXO. Referenced. Witness data is
 *              populated with the scriptPubKey + value the buyer
 *              specifies so the seller can sign without a round-trip.
 *              UNSIGNED at the time the PSBT leaves the buyer.
 *   Input 1+ — buyer's funding UTXOs. ALL SIGHASH_ALL.
 *   Output 0 — buyer's receive address, postage sats. The cat lands here
 *              because its sat is the first sat of the first output.
 *   Output 1 — seller's payment address, `priceSats`.
 *   Output 2 — buyer's change (skipped when sub-dust; absorbed into the
 *              miner fee).
 *
 * Why this is sniping-proof: the only signature missing at the time the PSBT
 * leaves the buyer is the seller's. Once the seller signs (SIGHASH_ALL),
 * every byte of the transaction is committed to by some signature; the
 * seller cannot mutate outputs, inputs, fees, or anything else without
 * invalidating the buyer's signatures. No half-signed PSBT can be spliced
 * into a sniping transaction.
 */
export function buildCat21BuyOfferPsbt(args: BuildCat21BuyOfferArgs): BuildCat21BuyOfferResult {
  const postageSats = args.postageSats ?? CAT21_OFFER_POSTAGE_SATS;
  if (args.priceSats <= 0) throw new Error('priceSats must be positive');
  if (postageSats < 330) throw new Error('postageSats below safe dust threshold');
  if (args.sellerInput.value < postageSats) {
    throw new Error('sellerInput.value below configured postage');
  }
  if (args.buyerInputs.length === 0) throw new Error('buyerInputs must be non-empty');
  if (args.feeSats < 0) throw new Error('feeSats must be non-negative');

  const scureNetwork = toScureNetwork(args.network);
  // lockTime = 21 makes the offer-acceptance tx a CAT-21 mint in addition
  // to a transfer: cat21-ord reads tx.lock_time structurally and mints a
  // fresh cat at output 0 (the buyer's receive output), onto the same
  // satoshi the existing cat ordinal travels to via FIFO. Per cat21/
  // README.md a single CAT-21 ordinal can carry multiple cats through
  // repeated minting. The value is pure data — block 21 was mined in
  // 2009, so the field has no consensus meaning.
  const tx = new btc.Transaction({ lockTime: 21, allowUnknownInputs: true });

  // Input 0: seller's cat UTXO, unsigned, sighash ALL pinned.
  tx.addInput({
    txid: args.sellerInput.txid,
    index: args.sellerInput.vout,
    witnessUtxo: {
      script: args.sellerInput.scriptPubKey,
      amount: BigInt(args.sellerInput.value),
    },
    sighashType: btc.SigHash.ALL,
  });

  // Inputs 1..N: buyer-funded.
  let buyerInputTotalSats = 0;
  for (const input of args.buyerInputs) {
    buyerInputTotalSats += input.value;
    const base: btc.TransactionInputUpdate = {
      txid: input.txid,
      index: input.vout,
      witnessUtxo: {
        script: input.scriptPubKey,
        amount: BigInt(input.value),
      },
      sighashType: btc.SigHash.ALL,
    };
    if (input.tapInternalKey) {
      tx.addInput({ ...base, tapInternalKey: input.tapInternalKey });
    } else {
      tx.addInput(base);
    }
  }

  // Output 0: cat lands at buyer.
  tx.addOutputAddress(
    args.destinations.buyerReceiveAddress,
    BigInt(postageSats),
    scureNetwork
  );

  // Output 1: seller payment.
  tx.addOutputAddress(
    args.destinations.sellerPaymentAddress,
    BigInt(args.priceSats),
    scureNetwork
  );

  // Output 2: buyer change when above dust. Buyer needs to fund:
  //   priceSats + postageSats - sellerInput.value (recycled via input 0) + feeSats.
  // Buyer contributes buyerInputTotalSats. Anything left over after the above
  // is change.
  const obligation = args.priceSats + postageSats - args.sellerInput.value + args.feeSats;
  const changeSats = buyerInputTotalSats - obligation;
  if (changeSats < 0) {
    throw new Error('Buyer inputs do not cover priceSats + postage + fee');
  }
  // Use the seller-payment script type's dust as a conservative floor; 546 is
  // safe across all current address types (taproot 330, segwit 294, p2sh 540).
  if (changeSats >= 546) {
    tx.addOutputAddress(
      args.destinations.buyerChangeAddress,
      BigInt(changeSats),
      scureNetwork
    );
  }

  // Sanity assert: every input MUST carry SIGHASH_ALL. SIGHASH_ALL
  // commits to the lockTime field across the whole tx (BIP-143 / legacy /
  // BIP-341), so once any input signs, the 21 marker is cryptographically
  // locked into the transaction.
  for (let i = 0; i < tx.inputsLength; i++) {
    if (tx.getInput(i).sighashType !== btc.SigHash.ALL) {
      throw new Error('Internal error: input sighashType drifted from SIGHASH_ALL');
    }
  }
  if (tx.lockTime !== 21) {
    throw new Error(`Internal error: lockTime=${tx.lockTime}, expected 21`);
  }

  return {
    hex: tx.hex,
    psbt: tx.toPSBT(),
    buyerInputTotalSats,
    changeSats: changeSats >= 546 ? changeSats : 0,
  };
}

/**
 * Arguments for `validateCat21BuyOfferPsbt` (seller-side).
 *
 * Before the seller signs an inbound buy-offer PSBT, the structure is checked
 * against the deal the seller actually agreed to. Any mismatch surfaces as a
 * typed `Cat21OfferRejectionReason` so the UI can render a precise reason
 * without leaking unrelated PSBT details.
 */
export interface ValidateCat21BuyOfferArgs {
  psbt: Uint8Array;
  expectedSellerUtxo: { txid: string; vout: number };
  /** Minimum acceptable price in sats. */
  floorPriceSats: number;
  /** Optional override; defaults to CAT21_OFFER_POSTAGE_SATS. */
  minPostageSats?: number;
  /**
   * Strongly recommended whenever a human eventually signs. When set, the
   * validator decodes Output 1's `scriptPubKey` back to an address string
   * and compares it against this value; mismatch returns
   * `'payment-output-wrong-address'`. Omitting it leaves the address
   * un-checked (pre-2026-06 behaviour, retained for backwards-compat).
   */
  expectedSellerPaymentAddress?: string;
  /**
   * Network used to decode Output 1's `scriptPubKey` back to an address.
   * Defaults to mainnet. Callers signing on testnet/regtest must pass it.
   */
  network?: Network;
}

/**
 * Validates the on-the-wire shape of an inbound buy-offer PSBT.
 *
 * Checks performed:
 *   1. Input 0 references the seller's cat-bearing UTXO (txid + vout).
 *   2. Every input carries `sighashType === SIGHASH_ALL` (or undefined for
 *      already-finalised inputs whose metadata was stripped — treated as
 *      pass-through because the signature itself commits to a specific
 *      sighash).
 *   3. Every input 1..N has a buyer signature attached (partialSig,
 *      tapKeySig, or finalScriptWitness).
 *   4. Output 0 (cat output) postage ≥ configured minimum.
 *   5. Output 1 (seller payment) ≥ floor price.
 *   6. When `expectedSellerPaymentAddress` is supplied, Output 1's
 *      `scriptPubKey` is decoded back to an address string and compared.
 *      Strongly recommended whenever a human eventually signs — the
 *      validator is the single source of truth for the wallet-side
 *      defence-in-depth check and cannot delegate this gate to a UI
 *      layer that may or may not exist.
 */
export function validateCat21BuyOfferPsbt(
  args: ValidateCat21BuyOfferArgs
): Cat21OfferValidation {
  const minPostage = args.minPostageSats ?? CAT21_OFFER_POSTAGE_SATS;
  const tx = btc.Transaction.fromPSBT(args.psbt);

  if (tx.inputsLength === 0) {
    return fail('missing-seller-input', 'tx has no inputs');
  }
  if (tx.outputsLength < 2) {
    return fail('missing-seller-payment-output', 'tx has fewer than 2 outputs');
  }

  // 1. Seller's input on index 0.
  const sellerInput = tx.getInput(0);
  const sellerTxidBytes = sellerInput.txid;
  const sellerTxid = sellerTxidBytes ? bytesToHex(sellerTxidBytes) : '';
  if (
    sellerTxid !== args.expectedSellerUtxo.txid ||
    sellerInput.index !== args.expectedSellerUtxo.vout
  ) {
    return fail('missing-seller-input', `got ${sellerTxid}:${sellerInput.index}`);
  }

  // 2. SIGHASH_ALL on every input. Already-finalised inputs may have
  //    sighashType undefined (stripped post-finalize); accept those because
  //    the signature itself commits to a specific sighash.
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    if (input.sighashType !== undefined && input.sighashType !== btc.SigHash.ALL) {
      return fail('sighash-not-all', `input ${i} sighashType=${input.sighashType}`);
    }
  }

  // 3. Buyer inputs (1..N) must be signed.
  for (let i = 1; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const hasSig =
      (input.partialSig && input.partialSig.length > 0) ||
      (input.tapKeySig && input.tapKeySig.length > 0) ||
      (input.finalScriptWitness && input.finalScriptWitness.length > 0);
    if (!hasSig) {
      return fail('buyer-input-unsigned', `input ${i} carries no signature`);
    }
  }

  // 4. Cat output postage.
  const catOutput = tx.getOutput(0);
  const postageSats = Number(catOutput.amount ?? 0n);
  if (postageSats < minPostage) {
    return fail('wrong-postage', `${postageSats} < ${minPostage}`);
  }

  const paymentOutput = tx.getOutput(1);

  // 5. Seller payment address — decoded from Output 1's scriptPubKey and
  //    compared against the caller-supplied expectation. Skipped when the
  //    expectation is absent (backwards-compat); strongly recommended
  //    whenever a human eventually signs. Runs BEFORE the price check so
  //    that a PSBT which is both underpriced AND points at the wrong
  //    address surfaces the more dangerous reason — the address attack —
  //    not the cheaper wrong-price one. Without this gate a malicious
  //    buyer can construct a PSBT where Output 1 pays a third address;
  //    signer-side UI fails to notice, cat moves to buyer, payment never
  //    reaches the seller.
  if (args.expectedSellerPaymentAddress !== undefined) {
    const scureNetwork = toScureNetwork(args.network ?? Network.Mainnet);
    let actualAddress: string;
    try {
      if (!paymentOutput.script) {
        return fail(
          'payment-output-wrong-address',
          'scriptPubKey not decodable to address'
        );
      }
      actualAddress = btc.Address(scureNetwork).encode(
        btc.OutScript.decode(paymentOutput.script)
      );
    } catch {
      return fail(
        'payment-output-wrong-address',
        'scriptPubKey not decodable to address'
      );
    }
    if (actualAddress !== args.expectedSellerPaymentAddress) {
      return fail(
        'payment-output-wrong-address',
        `expected ${args.expectedSellerPaymentAddress}, got ${actualAddress}`
      );
    }
  }

  // 6. Seller payment amount.
  const pricePaidSats = Number(paymentOutput.amount ?? 0n);
  if (pricePaidSats < args.floorPriceSats) {
    return fail('wrong-price', `${pricePaidSats} < ${args.floorPriceSats}`);
  }

  return { ok: true, pricePaidSats, postageSats };
}

function fail(reason: Cat21OfferRejectionReason, detail?: string): Cat21OfferValidation {
  return { ok: false, reason, detail };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
