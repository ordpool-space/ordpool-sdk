import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { CAT21_LOCK_TIME, assertCat21LockTime } from '../cat21-protocol/cat21-lock-time';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { CAT21_WALLET_INPUT_SEQUENCE } from '../cat21-protocol/cat21-sequence';
import { addressesEquivalent, getMinimumUtxoSize } from '../cat21-script/address-format';
import { addCat21Input } from '../cat21-script/prepare-cat21-input';
import { Network, toScureNetwork } from '../network';
import { OrdinalsAddress, PaymentAddress } from '../wallet/address-types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
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
  /**
   * The BUYER's wallet type. Currently unused for sequence-picking —
   * offers ship with `sequence = 0xfffffffd` (RBF on) for every wallet.
   * The mint-only RBF-off gate (`resolveCat21MintInputSequence`) is NOT
   * applied here: the cat is already on chain, so a third-party
   * accelerate UI dropping `lockTime=21` on an RBF replacement only
   * loses the bonus mint, not the cat itself. Kept in the type so
   * consumers keep sending it — future flows may need it.
   */
  walletType: KnownOrdinalWalletType;
  network: Network;
  sellerInput: Cat21OfferSellerInput;
  buyerInputs: Cat21OfferBuyerInput[];
  destinations: Cat21OfferDestinations;
  /**
   * Sats paid to the seller (net). The seller's payment output value is
   * `priceSats + sellerInput.value`, so the seller is made whole on whatever
   * they contribute via input 0 (any UTXO size) and nets exactly priceSats.
   */
  priceSats: number;
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
 * Builds the buyer-initiated CAT-21 offer PSBT (ord-style,
 * SIGHASH_ALL on every input).
 *
 * Structure:
 *   Input 0  — seller's cat UTXO. Witness data is pre-populated
 *              (scriptPubKey + value) so the seller can sign
 *              without a round-trip. UNSIGNED on emit.
 *   Input 1+ — buyer's funding UTXOs. All SIGHASH_ALL.
 *   Output 0 — buyer's receive address, postage sats. Cat lands here.
 *   Output 1 — seller's payment address, `priceSats`.
 *   Output 2 — buyer's change (absorbed into fee when sub-dust).
 *
 * Sniping-proof: when the PSBT leaves the buyer it's missing only
 * the seller's signature. Once the seller signs (SIGHASH_ALL),
 * every byte is committed by some signature — no half-signed PSBT
 * can be spliced into a sniping tx.
 */
export function buildCat21BuyOfferPsbt(args: BuildCat21BuyOfferArgs): BuildCat21BuyOfferResult {
  if (args.priceSats <= 0) throw new Error('priceSats must be positive');
  // Byte-parity with ord `wallet offer create`: output 0 (the cat/inscription
  // going to the buyer) is the seller's WHOLE UTXO at its real size, NOT a
  // forced 546. The buyer is purchasing that exact UTXO, so every sat and any
  // content on it (a co-located inscription, a rare sat past offset 546) must
  // travel intact to the buyer. Forcing 546 here would route the seller's sats
  // above offset 546 — and anything sitting on them — into output 1, merging
  // them with the seller's payment. 546 is only for outputs we mint fresh.
  const catOutputSats = args.sellerInput.value;
  if (args.buyerInputs.length === 0) throw new Error('buyerInputs must be non-empty');
  if (args.feeSats < 0) throw new Error('feeSats must be non-negative');

  const scureNetwork = toScureNetwork(args.network);
  // Per-wallet RBF sequence — same policy as mint and transfer (audit M4).
  // RBF-on (0xfffffffd) for every wallet on offers. The mint-only
  // RBF-off policy (`resolveCat21MintInputSequence`) does NOT apply
  // here: the cat is already on chain, so a third-party wallet's
  // accelerate UI dropping `lockTime=21` on an RBF replacement only
  // loses the bonus mint, not the cat itself. Third-party sellers
  // stuck at old fees CAN bump. The @scure default sequence is
  // 0xffffffff (final); we override explicitly so a future scure
  // change can't drift the behaviour.
  const sequenceNumber = CAT21_WALLET_INPUT_SEQUENCE;
  // lockTime = 21 makes the offer-acceptance tx a CAT-21 mint in addition
  // to a transfer: cat21-ord reads tx.lock_time structurally and mints a
  // fresh cat at output 0 (the buyer's receive output), onto the same
  // satoshi the existing cat ordinal travels to via FIFO.
  const tx = new btc.Transaction({ lockTime: CAT21_LOCK_TIME, allowUnknownInputs: true });

  // Input 0: seller's cat UTXO, unsigned, sighash ALL pinned, sequence
  // per the per-wallet policy resolved above.
  // Detect Taproot from the scriptPubKey shape (OP_1 + 0x20-prefixed
  // 32-byte push = 34 bytes total, starts with 0x51). On Taproot
  // inputs we OMIT sighashType — same BIP-341 rationale as in
  // cat21-mint.helper.ts.
  const sellerIsTaproot =
    args.sellerInput.scriptPubKey.length === 34 &&
    args.sellerInput.scriptPubKey[0] === 0x51;
  const sellerInput: btc.TransactionInputUpdate = {
    txid: args.sellerInput.txid,
    index: args.sellerInput.vout,
    sequence: sequenceNumber,
    witnessUtxo: {
      script: args.sellerInput.scriptPubKey,
      amount: BigInt(args.sellerInput.value),
    },
  };
  if (!sellerIsTaproot) sellerInput.sighashType = btc.SigHash.ALL;
  tx.addInput(sellerInput);

  // Inputs 1..N: buyer-funded. Same RBF-signalling sequence — keeps the
  // entire transaction replaceable as a unit.
  let buyerInputTotalSats = 0;
  for (const input of args.buyerInputs) {
    buyerInputTotalSats += input.value;
    addCat21Input(tx, input, sequenceNumber);
  }

  // Output 0: the whole cat/inscription UTXO lands at the buyer, at its real
  // size (ord parity). FIFO sends input 0's sats — the cat's first sat and
  // everything else on that UTXO — to this output.
  tx.addOutputAddress(
    args.destinations.buyerReceiveAddress,
    BigInt(catOutputSats),
    scureNetwork
  );

  // Output 1: seller payment. Value is `priceSats + sellerInput.value` so the
  // seller is made whole on WHATEVER they contribute via input 0 (any size,
  // not just 546); net to seller is exactly priceSats.
  tx.addOutputAddress(
    args.destinations.sellerPaymentAddress,
    BigInt(args.priceSats + args.sellerInput.value),
    scureNetwork
  );

  // Output 2: buyer change when above dust. Output 0 = sellerInput.value and
  // output 1 = priceSats + sellerInput.value; the seller's input (V) passes
  // straight back to the seller, so the buyer funds exactly the cat output (V)
  // + priceSats + fee = priceSats + V + fee (ord parity: amount + V + fee).
  const obligation = args.priceSats + catOutputSats + args.feeSats;
  const changeSats = buyerInputTotalSats - obligation;
  if (changeSats < 0) {
    throw new Error('Buyer inputs do not cover priceSats + cat UTXO value + fee');
  }
  // Per-address-type dust floor for the buyer's change output. 546
  // is the conservative cross-type floor (taproot 330, segwit 294,
  // p2sh 540) and stays as the defence-in-depth fallback if
  // getMinimumUtxoSize can't classify the address; the per-address
  // value is preferred so P2TR (330) and P2WPKH (294) change amounts
  // in [dust, 546) are actually emitted instead of silently absorbed
  // into the miner fee.
  let changeDustLimit: number;
  try {
    changeDustLimit = getMinimumUtxoSize(args.destinations.buyerChangeAddress);
  } catch {
    changeDustLimit = 546;
  }
  if (changeSats >= changeDustLimit) {
    tx.addOutputAddress(
      args.destinations.buyerChangeAddress,
      BigInt(changeSats),
      scureNetwork
    );
  }

  // Sanity asserts. SIGHASH_ALL commits to lockTime + sequence across
  // the whole tx (BIP-143 / legacy / BIP-341), so once any input signs,
  // the 21 marker AND the RBF-signalling sequence are cryptographically
  // locked into the transaction.
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    // Taproot inputs intentionally omit sighashType (SIGHASH_DEFAULT ≡
    // SIGHASH_ALL on the wire for key-path spends, BIP-341).
    const isTaproot =
      !!input.tapInternalKey ||
      (input.witnessUtxo?.script?.length === 34 && input.witnessUtxo.script[0] === 0x51);
    if (!isTaproot && input.sighashType !== btc.SigHash.ALL) {
      throw new Error('Internal error: input sighashType drifted from SIGHASH_ALL');
    }
    if (input.sequence !== sequenceNumber) {
      throw new Error(
        `Internal error: input ${i} sequence=${input.sequence}, expected ${sequenceNumber}`
      );
    }
  }
  assertCat21LockTime(tx.lockTime);

  return {
    hex: tx.hex,
    psbt: tx.toPSBT(),
    buyerInputTotalSats,
    changeSats: changeSats >= changeDustLimit ? changeSats : 0,
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
/**
 * Hard cap on the raw PSBT bytes passed to the validator. Mirrors the
 * `Cat21OperationGate`'s cap so non-Angular callers (cat21-wallet,
 * scripts) get the same protection. A real CAT-21 buy-offer is <1 KB;
 * 128 KiB is generous headroom while still blocking adversarial blobs.
 */
export const MAX_BUY_OFFER_PSBT_BYTES = 128 * 1024;

export interface ValidateCat21BuyOfferArgs {
  psbt: Uint8Array;
  expectedSellerUtxo: { txid: string; vout: number };
  /** Minimum acceptable price in sats. Must be supplied; 0 is legal but the caller has to type it. */
  floorPriceSats: number;
  /**
   * REQUIRED. Without this, a malicious buyer can build a PSBT whose
   * Output 1 pays anywhere (including the buyer's own change), and the
   * validator only checks the amount, not the destination. The seller
   * would sign, the cat would move, and the payment would never arrive.
   * Made mandatory as of audit C1.
   */
  expectedSellerPaymentAddress: PaymentAddress;
  /**
   * Network used to decode Output 1's `scriptPubKey` back to an address.
   * Defaults to mainnet. Callers signing on testnet/regtest must pass it.
   */
  network?: Network;
  /**
   * Optional. Marketplace-side check: when supplied, Output 0's script
   * is decoded and compared. Rejects with `cat-output-wrong-address` on
   * mismatch. A bare seller-side caller (no marketplace context) can
   * omit this; a marketplace indexer verifying "buyer signed for the
   * cat to go where their DTO claims" should always pass it.
   */
  expectedBuyerReceiveAddress?: OrdinalsAddress;
  /**
   * Optional. Marketplace-side check: when supplied AND Output 2
   * exists, Output 2's script is decoded and compared. Rejects with
   * `change-output-wrong-address` on mismatch. A tx with no Output 2
   * (buyer had no change) passes even when this arg is set.
   */
  expectedBuyerChangeAddress?: PaymentAddress;
  /**
   * Optional. Marketplace-side check: when supplied, tightens the
   * existing floor-based `pricePaidSats >= floorPriceSats` gate to an
   * EXACT equality (`pricePaidSats === expectedExactPrice`). Rejects
   * with `wrong-price-exact` on mismatch. Use when the buyer's DTO
   * declared a specific price and any deviation is signature drift.
   */
  expectedExactPrice?: number;
}

/**
 * Validates the on-the-wire shape of an inbound buy-offer PSBT.
 *
 * **Scope rule — read this before adding a check:** this validator
 * protects the SELLER. "Whose loss is this?" — gate ONLY on things
 * that hurt the seller. Buyer-side optimization losses (no bonus-mint
 * cat from a missing `lockTime=21`, SIGHASH_DEFAULT-on-Taproot when
 * the buyer wanted SIGHASH_ALL, …) are NOT the seller's problem and
 * MUST NOT be grounds for rejection — a rejected offer is a lost sale.
 * See `feedback_validator_audience_check` memory.
 *
 *   1. Input 0 references the seller's cat UTXO.
 *   2. Every input has `sighashType === SIGHASH_ALL` (or undefined
 *      for already-finalised inputs — the embedded signature itself
 *      commits to its sighash).
 *   3. Every input 1..N carries a buyer signature (partialSig,
 *      tapKeySig, or finalScriptWitness).
 *   4. Output 0 (cat) postage ≥ configured minimum, script decodable.
 *   5. Output 1 (seller payment) ≥ floor price.
 *   6. When `expectedSellerPaymentAddress` is supplied, Output 1's
 *      script is decoded and compared. Strongly recommended whenever
 *      a human eventually signs — the validator is the single source
 *      of truth and can't delegate to a UI layer that may or may
 *      not exist.
 *
 * Optional marketplace-side gates (only fire when the corresponding
 * `expected*` arg is supplied):
 *
 *   7. `expectedBuyerReceiveAddress` — Output 0's decoded address must
 *      match. Rejects `cat-output-wrong-address` on mismatch. Catches
 *      "buyer signed for the cat to go somewhere other than the
 *      address their marketplace DTO claims".
 *   8. `expectedBuyerChangeAddress` — Output 2's decoded address, when
 *      Output 2 exists, must match. Rejects `change-output-wrong-address`.
 *      Silent (no failure) when the tx has no Output 2.
 *   9. `expectedExactPrice` — tightens the floor gate to exact equality.
 *      Rejects `wrong-price-exact` on any deviation. Use when the DTO
 *      declared a specific price and drift means signature tampering.
 */
export function validateCat21BuyOfferPsbt(
  args: ValidateCat21BuyOfferArgs
): Cat21OfferValidation {
  // 0a. Size cap. Mirrors Cat21OperationGate.MAX_OFFER_PSBT_BYTES so
  //     direct callers (cat21-wallet, scripts) get the same DoS guard.
  if (args.psbt.byteLength > MAX_BUY_OFFER_PSBT_BYTES) {
    return fail(
      'malformed-offer-psbt',
      `psbt too large: ${args.psbt.byteLength} > ${MAX_BUY_OFFER_PSBT_BYTES}`,
    );
  }

  // 0b. Magic bytes. PSBT magic is 0x70 0x73 0x62 0x74 0xff. Reject
  //     anything else before scure tries to parse — keeps a cheap
  //     adversarial blob from reaching the heavier parser.
  if (
    args.psbt.byteLength < 5
    || args.psbt[0] !== 0x70
    || args.psbt[1] !== 0x73
    || args.psbt[2] !== 0x62
    || args.psbt[3] !== 0x74
    || args.psbt[4] !== 0xff
  ) {
    return fail('malformed-offer-psbt', 'not a PSBT (magic bytes mismatch)');
  }

  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(args.psbt);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail('malformed-offer-psbt', `PSBT parse failed: ${detail}`);
  }

  if (tx.inputsLength === 0) {
    return fail('malformed-offer-psbt', 'tx has no inputs');
  }
  if (tx.outputsLength < 2) {
    return fail('missing-seller-payment-output', 'tx has fewer than 2 outputs');
  }

  // DELIBERATELY NOT CHECKED: tx.lockTime !== 21.
  // The validator's job is to protect the SELLER. lockTime=21 is a
  // BUYER-side optimization — it triggers cat21-ord's bonus-mint at
  // output 0 (a free fresh cat on the same ordinal). If the buyer
  // shipped lockTime=0, the cat still transfers, the seller still
  // gets paid, the tx broadcasts cleanly; the only loss is the
  // buyer's bonus-mint cat — entirely their own.
  //
  // Rejecting a valid sale here would kill liquidity: a buyer using
  // ord.cat21.space's `wallet offer create` (or any other CAT-21-aware
  // tool) gets lockTime=21 automatically; a buyer using vanilla ord
  // gets lockTime=0; both are legitimate sales from the seller's
  // perspective. Whose-loss-is-this filter, see memory feedback file
  // `validator-audience-check`.

  // 1. Seller's input on index 0.
  const sellerInput = tx.getInput(0);
  const sellerTxidBytes = sellerInput.txid;
  const sellerTxid = sellerTxidBytes ? hex.encode(sellerTxidBytes) : '';
  if (
    sellerTxid !== args.expectedSellerUtxo.txid ||
    sellerInput.index !== args.expectedSellerUtxo.vout
  ) {
    return fail('missing-seller-input', `got ${sellerTxid}:${sellerInput.index}`);
  }

  // 1b. Read the seller's input value for the price calculation below. It can
  //     be ANY size: a cat sits on whatever UTXO it was minted on, not
  //     necessarily 546. A buyer who lies about this amount only breaks their
  //     own tx — the seller signs over the claimed amount, so a wrong amount
  //     fails sig-verify at mempool — and the floor-price check (step 6)
  //     protects the seller's net regardless of the claimed value.
  const sellerInputValueSats = Number(sellerInput.witnessUtxo?.amount ?? 0n);

  // 2a. SIGHASH_ALL on every input (PSBT field check). Already-finalised
  //     inputs may have sighashType undefined; for those see 2b below.
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    if (input.sighashType !== undefined && input.sighashType !== btc.SigHash.ALL) {
      return fail('sighash-not-all', `input ${i} sighashType=${input.sighashType}`);
    }
  }

  // 2b. Actual signature-byte sighash flag. A malicious buyer could leave
  //     the PSBT sighashType field unset (or ALL) while signing with
  //     SIGHASH_SINGLE|ANYONECANPAY, so the field-only check (2a) is weaker
  //     than the "all inputs committed under SIGHASH_ALL" promise. Read the
  //     trailing byte of partialSig (ECDSA) and assert it's 0x01. Schnorr
  //     signatures (Taproot key-path) omit the flag when sighash is DEFAULT
  //     (= ALL); a 65-byte Schnorr sig carries the flag in its last byte.
  //     Both shapes are wire-equivalent to SIGHASH_ALL when the flag is
  //     absent or 0x01.
  //
  //     Scope: this inspects partialSig / tapKeySig only. A buyer input that
  //     is already FINALISED (bytes in finalScriptWitness) is not re-decoded
  //     here, so its sighash flag is not re-verified. That is safe by
  //     construction: the SELLER signs input 0 (the cat) with SIGHASH_ALL,
  //     which commits every input and every output. Once the seller signs,
  //     the cat can move only via this exact transaction, paying the seller
  //     the agreed amount to the agreed address; a buyer's own-input sighash
  //     cannot redirect the cat or shrink the payout without invalidating
  //     the seller's signature and making the tx un-broadcastable. The
  //     seller's safety rests on input 0, not on re-checking a finalised
  //     buyer input.
  for (let i = 1; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    if (input.partialSig && input.partialSig.length > 0) {
      for (const entry of input.partialSig) {
        // partialSig entries are [pubkey, sig] tuples per BIP-174.
        const sig = entry[1];
        const flagByte = sig[sig.length - 1];
        if (flagByte !== btc.SigHash.ALL) {
          return fail(
            'sighash-flag-byte-not-all',
            `input ${i} ECDSA sig sighash flag byte = 0x${flagByte.toString(16)}, expected 0x01`,
          );
        }
      }
    }
    if (input.tapKeySig && input.tapKeySig.length === 65) {
      // 65-byte Schnorr sig: last byte is the sighash flag.
      const flagByte = input.tapKeySig[64];
      if (flagByte !== btc.SigHash.ALL) {
        return fail(
          'sighash-flag-byte-not-all',
          `input ${i} Schnorr sig sighash flag byte = 0x${flagByte.toString(16)}, expected 0x01`,
        );
      }
    }
    // 64-byte Schnorr sig = SIGHASH_DEFAULT = wire-equivalent to ALL ✓
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

  // 4. Cat output (output 0) must decode to a spendable address AND clear
  //    that address's dust floor. Its value is DELIBERATELY NOT pinned to
  //    546. A cat rides whatever UTXO it was minted on — any size, by any
  //    tx, not only ours — and a stock-ord `wallet offer create` sets
  //    output 0 to the inscription's REAL postage (ord's own test at
  //    cat21-ord/tests/wallet/offer/create.rs inscribes 9000 sats and
  //    asserts output[0].value == 9000). Pinning 546 here would reject
  //    every valid ord-built offer whose cat/inscription doesn't happen to
  //    sit on exactly 546 sats — i.e. the "buy an inscription-that-is-
  //    also-a-cat from stock ord" flow. The value can't hurt the SELLER
  //    either: step 6 nets the payout as `output1 - sellerInputValue`,
  //    independent of output 0. The only seller-relevant failure is a
  //    below-dust output 0 that makes the settlement tx un-relayable (the
  //    seller would sign a tx that can never confirm), so that we gate —
  //    via the real per-address dust floor, the same helper the builder
  //    uses for the buyer's change output.
  //
  //    Script must also decode to a real address: without it a malicious
  //    buyer could route output 0 to an OP_RETURN, burning the cat after
  //    the seller signs (buyer gets nothing either, but the cat is gone).
  const catOutput = tx.getOutput(0);
  const scureNetwork = toScureNetwork(args.network ?? Network.Mainnet);
  if (!catOutput.script) {
    return fail('cat-output-not-spendable', 'cat output has no scriptPubKey');
  }
  let catOutputAddress: string;
  try {
    catOutputAddress = btc.Address(scureNetwork).encode(btc.OutScript.decode(catOutput.script));
  } catch {
    return fail('cat-output-not-spendable', 'cat output scriptPubKey not a real address');
  }
  const postageSats = Number(catOutput.amount ?? 0n);
  let catOutputDustFloor: number;
  try {
    catOutputDustFloor = getMinimumUtxoSize(catOutputAddress);
  } catch {
    catOutputDustFloor = CAT21_POSTAGE_SATS;
  }
  if (postageSats < catOutputDustFloor) {
    return fail('wrong-postage', `cat output ${postageSats} < dust floor ${catOutputDustFloor}`);
  }

  // 4c. Marketplace-side: cat output address must match the buyer's
  //     declared receive address. Only runs when the caller supplies
  //     `expectedBuyerReceiveAddress` (marketplace indexer path).
  if (args.expectedBuyerReceiveAddress !== undefined) {
    if (!addressesEquivalent(catOutputAddress, args.expectedBuyerReceiveAddress, scureNetwork)) {
      return fail(
        'cat-output-wrong-address',
        `expected ${args.expectedBuyerReceiveAddress}, got ${catOutputAddress}`,
      );
    }
  }

  const paymentOutput = tx.getOutput(1);

  // 5. Seller payment address — decoded from Output 1's scriptPubKey
  //    and compared against the caller's expectation. **REQUIRED** as
  //    of audit C1; mandatory in the args type so a caller cannot
  //    accidentally omit it. Runs BEFORE the price check so an under-
  //    priced AND mis-addressed PSBT surfaces the address attack first.
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
  if (!addressesEquivalent(actualAddress, args.expectedSellerPaymentAddress, scureNetwork)) {
    return fail(
      'payment-output-wrong-address',
      `expected ${args.expectedSellerPaymentAddress}, got ${actualAddress}`
    );
  }

  // 6. Seller payment amount. Output 1's value is `priceSats + sellerInputValue`,
  //    so the seller's net is `output1 - sellerInputValue` = priceSats,
  //    independent of the cat UTXO's size. Compare net-to-seller against the
  //    caller's floor.
  const paymentOutputValue = Number(paymentOutput.amount ?? 0n);
  const pricePaidSats = paymentOutputValue - sellerInputValueSats;
  if (pricePaidSats < args.floorPriceSats) {
    return fail('wrong-price', `${pricePaidSats} < ${args.floorPriceSats}`);
  }

  // 6b. Marketplace-side: exact-price match. Runs only when the caller
  //     supplies `expectedExactPrice`. Catches "buyer's DTO claims price
  //     X but the PSBT actually pays X±Δ" — signature drift or
  //     mislabelled bid.
  if (args.expectedExactPrice !== undefined && pricePaidSats !== args.expectedExactPrice) {
    return fail(
      'wrong-price-exact',
      `pricePaidSats=${pricePaidSats} !== expected ${args.expectedExactPrice}`,
    );
  }

  // 7. Marketplace-side: Output 2 (buyer change) must go to the
  //     declared buyer change address. When the PSBT has no Output 2
  //     (buyer had no change), this check silently passes — a
  //     no-change tx is a valid shape. Only runs when the caller
  //     supplies `expectedBuyerChangeAddress`.
  if (args.expectedBuyerChangeAddress !== undefined && tx.outputsLength >= 3) {
    const changeOutput = tx.getOutput(2);
    if (!changeOutput.script) {
      return fail('change-output-wrong-address', 'change output has no scriptPubKey');
    }
    let changeAddress: string;
    try {
      changeAddress = btc.Address(scureNetwork).encode(btc.OutScript.decode(changeOutput.script));
    } catch {
      return fail('change-output-wrong-address', 'change output scriptPubKey not a real address');
    }
    if (!addressesEquivalent(changeAddress, args.expectedBuyerChangeAddress, scureNetwork)) {
      return fail(
        'change-output-wrong-address',
        `expected ${args.expectedBuyerChangeAddress}, got ${changeAddress}`,
      );
    }
  }

  return { ok: true, pricePaidSats, postageSats };
}


function fail(reason: Cat21OfferRejectionReason, detail?: string): Cat21OfferValidation {
  return { ok: false, reason, detail };
}
