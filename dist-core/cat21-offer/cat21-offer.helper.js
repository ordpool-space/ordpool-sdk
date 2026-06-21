"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BUY_OFFER_PSBT_BYTES = exports.CAT21_OFFER_INPUT_SEQUENCE = void 0;
exports.buildCat21BuyOfferPsbt = buildCat21BuyOfferPsbt;
exports.validateCat21BuyOfferPsbt = validateCat21BuyOfferPsbt;
const btc = __importStar(require("@scure/btc-signer"));
const cat21_postage_1 = require("../cat21-protocol/cat21-postage");
const cat21_sequence_1 = require("../cat21-protocol/cat21-sequence");
const network_1 = require("../network");
/**
 * Sequence number set on every input of a CAT-21 buy-offer PSBT.
 *
 * `0xfffffffd` signals BIP-125 RBF — the buyer (or any party with the
 * authority to rebuild the tx) can submit a higher-fee replacement if
 * the mempool congests after broadcast. This is the SDK default for
 * non-mint cat-flows per the cat21-wallet HARD RULE #1: offers and
 * transfers allow RBF; the only flow that disables RBF is the mint
 * (and only for third-party wallets that can't be trusted to preserve
 * `lockTime=21` through a replacement — see
 * `cat21-mint/cat21.service.helper.ts:CAT21_MINT_INPUT_SEQUENCE`).
 *
 * `@scure/btc-signer`'s default sequence is `0xffffffff` (final, RBF
 * off), so this MUST be set explicitly. Verified by reading the
 * scure source (`DEFAULT_SEQUENCE = 4294967295`).
 */
/**
 * @deprecated Use `resolveCat21InputSequence(walletType)` per the
 * per-wallet RBF policy unified across mint / transfer / offer flows
 * (audit M4). Left exported for spec backwards-compat; new callers
 * should not consume this constant directly.
 */
exports.CAT21_OFFER_INPUT_SEQUENCE = 0xfffffffd;
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
function buildCat21BuyOfferPsbt(args) {
    const postageSats = cat21_postage_1.CAT21_POSTAGE_SATS;
    if (args.priceSats <= 0)
        throw new Error('priceSats must be positive');
    // HARD RULE: cat UTXO is always 546 sats. See SDK CLAUDE.md. Enforce
    // structurally so a caller can't smuggle a non-protocol-shaped UTXO
    // through the offer flow.
    if (args.sellerInput.value !== cat21_postage_1.CAT21_POSTAGE_SATS) {
        throw new Error(`sellerInput.value must equal CAT21_POSTAGE_SATS (${cat21_postage_1.CAT21_POSTAGE_SATS}); got ${args.sellerInput.value}`);
    }
    if (args.buyerInputs.length === 0)
        throw new Error('buyerInputs must be non-empty');
    if (args.feeSats < 0)
        throw new Error('feeSats must be non-negative');
    const scureNetwork = (0, network_1.toScureNetwork)(args.network);
    // Per-wallet RBF sequence — same policy as mint and transfer (audit M4).
    // cat21-wallet → 0xfffffffd (RBF on; our accelerate flow preserves
    // lockTime=21). All other wallets → 0xfffffffe (RBF off; third-party
    // accelerate UIs can't fire and drop the marker, which would cost the
    // buyer the bonus-mint cat). The @scure default sequence is 0xffffffff
    // (final); we override explicitly so a future scure change can't drift
    // the behaviour.
    const sequenceNumber = (0, cat21_sequence_1.resolveCat21InputSequence)(args.walletType);
    // lockTime = 21 makes the offer-acceptance tx a CAT-21 mint in addition
    // to a transfer: cat21-ord reads tx.lock_time structurally and mints a
    // fresh cat at output 0 (the buyer's receive output), onto the same
    // satoshi the existing cat ordinal travels to via FIFO.
    const tx = new btc.Transaction({ lockTime: 21, allowUnknownInputs: true });
    // Input 0: seller's cat UTXO, unsigned, sighash ALL pinned, sequence
    // per the per-wallet policy resolved above.
    // Detect Taproot from the scriptPubKey shape (OP_1 + 0x20-prefixed
    // 32-byte push = 34 bytes total, starts with 0x51). On Taproot
    // inputs we OMIT sighashType — same BIP-341 rationale as in
    // cat21-mint.helper.ts.
    const sellerIsTaproot = args.sellerInput.scriptPubKey.length === 34 &&
        args.sellerInput.scriptPubKey[0] === 0x51;
    const sellerInput = {
        txid: args.sellerInput.txid,
        index: args.sellerInput.vout,
        sequence: sequenceNumber,
        witnessUtxo: {
            script: args.sellerInput.scriptPubKey,
            amount: BigInt(args.sellerInput.value),
        },
    };
    if (!sellerIsTaproot)
        sellerInput.sighashType = btc.SigHash.ALL;
    tx.addInput(sellerInput);
    // Inputs 1..N: buyer-funded. Same RBF-signalling sequence — keeps the
    // entire transaction replaceable as a unit.
    let buyerInputTotalSats = 0;
    for (const input of args.buyerInputs) {
        buyerInputTotalSats += input.value;
        // Legacy P2PKH path: scure refuses witnessUtxo on legacy inputs.
        if (input.nonWitnessUtxo) {
            const legacyInput = {
                txid: input.txid,
                index: input.vout,
                sequence: sequenceNumber,
                nonWitnessUtxo: input.nonWitnessUtxo,
                sighashType: btc.SigHash.ALL,
            };
            if (input.redeemScript)
                legacyInput.redeemScript = input.redeemScript;
            tx.addInput(legacyInput);
            continue;
        }
        // SegWit family.
        const isTaproot = !!input.tapInternalKey;
        const base = {
            txid: input.txid,
            index: input.vout,
            sequence: sequenceNumber,
            witnessUtxo: {
                script: input.scriptPubKey,
                amount: BigInt(input.value),
            },
        };
        if (!isTaproot)
            base.sighashType = btc.SigHash.ALL;
        if (input.redeemScript)
            base.redeemScript = input.redeemScript;
        if (input.tapInternalKey)
            base.tapInternalKey = input.tapInternalKey;
        tx.addInput(base);
    }
    // Output 0: cat lands at buyer.
    tx.addOutputAddress(args.destinations.buyerReceiveAddress, BigInt(postageSats), scureNetwork);
    // Output 1: seller payment. Value is `priceSats + postageSats` so the
    // seller is made whole on the 546 sats they contribute via input 0 —
    // matching ord's `wallet offer create` convention. Without the
    // `+ postageSats`, the seller would silently eat the postage every
    // time they sell. Net to seller: priceSats.
    tx.addOutputAddress(args.destinations.sellerPaymentAddress, BigInt(args.priceSats + postageSats), scureNetwork);
    // Output 2: buyer change when above dust. Buyer pays:
    //   priceSats + postageSats (to seller) + postageSats (cat output) + feeSats.
    // The seller's input value flows to output 1; it does NOT subsidise
    // the buyer's obligation. Buyer's net cost == priceSats + postageSats + feeSats.
    const obligation = args.priceSats + postageSats * 2 - args.sellerInput.value + args.feeSats;
    const changeSats = buyerInputTotalSats - obligation;
    if (changeSats < 0) {
        throw new Error('Buyer inputs do not cover priceSats + 2*postage + fee - sellerInput.value');
    }
    // Use the seller-payment script type's dust as a conservative floor; 546 is
    // safe across all current address types (taproot 330, segwit 294, p2sh 540).
    if (changeSats >= 546) {
        tx.addOutputAddress(args.destinations.buyerChangeAddress, BigInt(changeSats), scureNetwork);
    }
    // Sanity asserts. SIGHASH_ALL commits to lockTime + sequence across
    // the whole tx (BIP-143 / legacy / BIP-341), so once any input signs,
    // the 21 marker AND the RBF-signalling sequence are cryptographically
    // locked into the transaction.
    for (let i = 0; i < tx.inputsLength; i++) {
        const input = tx.getInput(i);
        // Taproot inputs intentionally omit sighashType (SIGHASH_DEFAULT ≡
        // SIGHASH_ALL on the wire for key-path spends, BIP-341).
        const isTaproot = !!input.tapInternalKey ||
            (input.witnessUtxo?.script?.length === 34 && input.witnessUtxo.script[0] === 0x51);
        if (!isTaproot && input.sighashType !== btc.SigHash.ALL) {
            throw new Error('Internal error: input sighashType drifted from SIGHASH_ALL');
        }
        if (input.sequence !== sequenceNumber) {
            throw new Error(`Internal error: input ${i} sequence=${input.sequence}, expected ${sequenceNumber}`);
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
/**
 * Hard cap on the raw PSBT bytes passed to the validator. Mirrors the
 * `Cat21OperationGate`'s cap so non-Angular callers (cat21-wallet,
 * scripts) get the same protection. A real CAT-21 buy-offer is <1 KB;
 * 128 KiB is generous headroom while still blocking adversarial blobs.
 */
exports.MAX_BUY_OFFER_PSBT_BYTES = 128 * 1024;
/**
 * Validates the on-the-wire shape of an inbound buy-offer PSBT.
 *
 *   1. Input 0 references the seller's cat UTXO.
 *   2. Every input has `sighashType === SIGHASH_ALL` (or undefined
 *      for already-finalised inputs — the embedded signature itself
 *      commits to its sighash).
 *   3. Every input 1..N carries a buyer signature (partialSig,
 *      tapKeySig, or finalScriptWitness).
 *   4. Output 0 (cat) postage ≥ configured minimum.
 *   5. Output 1 (seller payment) ≥ floor price.
 *   6. When `expectedSellerPaymentAddress` is supplied, Output 1's
 *      script is decoded and compared. Strongly recommended whenever
 *      a human eventually signs — the validator is the single source
 *      of truth and can't delegate to a UI layer that may or may
 *      not exist.
 */
function validateCat21BuyOfferPsbt(args) {
    // 0a. Size cap. Mirrors Cat21OperationGate.MAX_OFFER_PSBT_BYTES so
    //     direct callers (cat21-wallet, scripts) get the same DoS guard.
    if (args.psbt.byteLength > exports.MAX_BUY_OFFER_PSBT_BYTES) {
        return fail('missing-seller-input', `psbt too large: ${args.psbt.byteLength} > ${exports.MAX_BUY_OFFER_PSBT_BYTES}`);
    }
    // 0b. Magic bytes. PSBT magic is 0x70 0x73 0x62 0x74 0xff. Reject
    //     anything else before scure tries to parse — keeps a cheap
    //     adversarial blob from reaching the heavier parser.
    if (args.psbt.byteLength < 5
        || args.psbt[0] !== 0x70
        || args.psbt[1] !== 0x73
        || args.psbt[2] !== 0x62
        || args.psbt[3] !== 0x74
        || args.psbt[4] !== 0xff) {
        return fail('missing-seller-input', 'not a PSBT (magic bytes mismatch)');
    }
    let tx;
    try {
        tx = btc.Transaction.fromPSBT(args.psbt);
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return fail('missing-seller-input', `PSBT parse failed: ${detail}`);
    }
    if (tx.inputsLength === 0) {
        return fail('missing-seller-input', 'tx has no inputs');
    }
    if (tx.outputsLength < 2) {
        return fail('missing-seller-payment-output', 'tx has fewer than 2 outputs');
    }
    // 0c. lockTime must be 21 (the CAT-21 marker). The seller signing a
    //     lockTime=0 PSBT still transfers the cat, but the cherry-on-top
    //     bonus-mint is silently dropped — a strict loss vs the ord-style
    //     offer contract. Per audit finding M2.
    if (tx.lockTime !== 21) {
        return fail('lock-time-not-21', `tx.lockTime = ${tx.lockTime}, expected 21`);
    }
    // 1. Seller's input on index 0.
    const sellerInput = tx.getInput(0);
    const sellerTxidBytes = sellerInput.txid;
    const sellerTxid = sellerTxidBytes ? bytesToHex(sellerTxidBytes) : '';
    if (sellerTxid !== args.expectedSellerUtxo.txid ||
        sellerInput.index !== args.expectedSellerUtxo.vout) {
        return fail('missing-seller-input', `got ${sellerTxid}:${sellerInput.index}`);
    }
    // 1b. Seller's input value MUST be 546 sats (the CAT-21 postage
    //     invariant). Without this assert, a lying `witnessUtxo.amount`
    //     would skew the `pricePaidSats` calculation below — mempool
    //     would reject the signed tx (sig-verify-flag-failed against the
    //     lied amount), so this isn't theft, but it's worse UX than
    //     stopping the validator here.
    const sellerInputValueSats = Number(sellerInput.witnessUtxo?.amount ?? 0n);
    if (sellerInputValueSats !== cat21_postage_1.CAT21_POSTAGE_SATS) {
        return fail('wrong-seller-input-value', `seller input witnessUtxo.amount = ${sellerInputValueSats}, expected ${cat21_postage_1.CAT21_POSTAGE_SATS}`);
    }
    // 2a. SIGHASH_ALL on every input (PSBT field check). Already-finalised
    //     inputs may have sighashType undefined; for those see 2b below.
    for (let i = 0; i < tx.inputsLength; i++) {
        const input = tx.getInput(i);
        if (input.sighashType !== undefined && input.sighashType !== btc.SigHash.ALL) {
            return fail('sighash-not-all', `input ${i} sighashType=${input.sighashType}`);
        }
    }
    // 2b. Actual signature-byte sighash flag. A malicious buyer could
    //     leave the PSBT sighashType field unset (or ALL) while signing
    //     with SIGHASH_SINGLE|ANYONECANPAY — the validator's promise of
    //     "all inputs committed under SIGHASH_ALL" is weaker than the
    //     field-only check claims. Read the trailing byte of partialSig
    //     (ECDSA) and assert it's 0x01. Schnorr signatures (Taproot key-
    //     path) omit the flag when sighash is DEFAULT (= ALL); a 65-byte
    //     Schnorr sig carries the flag in its last byte. Both shapes are
    //     wire-equivalent to SIGHASH_ALL when the flag is absent or 0x01.
    for (let i = 1; i < tx.inputsLength; i++) {
        const input = tx.getInput(i);
        if (input.partialSig && input.partialSig.length > 0) {
            for (const entry of input.partialSig) {
                // partialSig entries are [pubkey, sig] tuples per BIP-174.
                const sig = entry[1];
                const flagByte = sig[sig.length - 1];
                if (flagByte !== btc.SigHash.ALL) {
                    return fail('sighash-flag-byte-not-all', `input ${i} ECDSA sig sighash flag byte = 0x${flagByte.toString(16)}, expected 0x01`);
                }
            }
        }
        if (input.tapKeySig && input.tapKeySig.length === 65) {
            // 65-byte Schnorr sig: last byte is the sighash flag.
            const flagByte = input.tapKeySig[64];
            if (flagByte !== btc.SigHash.ALL) {
                return fail('sighash-flag-byte-not-all', `input ${i} Schnorr sig sighash flag byte = 0x${flagByte.toString(16)}, expected 0x01`);
            }
        }
        // 64-byte Schnorr sig = SIGHASH_DEFAULT = wire-equivalent to ALL ✓
    }
    // 3. Buyer inputs (1..N) must be signed.
    for (let i = 1; i < tx.inputsLength; i++) {
        const input = tx.getInput(i);
        const hasSig = (input.partialSig && input.partialSig.length > 0) ||
            (input.tapKeySig && input.tapKeySig.length > 0) ||
            (input.finalScriptWitness && input.finalScriptWitness.length > 0);
        if (!hasSig) {
            return fail('buyer-input-unsigned', `input ${i} carries no signature`);
        }
    }
    // 4. Cat output postage MUST equal CAT21_POSTAGE_SATS (546). See HARD
    //    RULE "cat UTXO is always 546 sats" in SDK CLAUDE.md.
    const catOutput = tx.getOutput(0);
    const postageSats = Number(catOutput.amount ?? 0n);
    if (postageSats !== cat21_postage_1.CAT21_POSTAGE_SATS) {
        return fail('wrong-postage', `${postageSats} !== ${cat21_postage_1.CAT21_POSTAGE_SATS}`);
    }
    // 4b. Cat output script must decode to a spendable address on the
    //     configured network. Without this check a malicious buyer could
    //     route Output 0 to an OP_RETURN, burning the cat after the seller
    //     signs. Buyer gets nothing either, but the cat is destroyed.
    const scureNetwork = (0, network_1.toScureNetwork)(args.network ?? network_1.Network.Mainnet);
    if (!catOutput.script) {
        return fail('cat-output-not-spendable', 'cat output has no scriptPubKey');
    }
    try {
        btc.Address(scureNetwork).encode(btc.OutScript.decode(catOutput.script));
    }
    catch {
        return fail('cat-output-not-spendable', 'cat output scriptPubKey not a real address');
    }
    const paymentOutput = tx.getOutput(1);
    // 5. Seller payment address — decoded from Output 1's scriptPubKey
    //    and compared against the caller's expectation. **REQUIRED** as
    //    of audit C1; mandatory in the args type so a caller cannot
    //    accidentally omit it. Runs BEFORE the price check so an under-
    //    priced AND mis-addressed PSBT surfaces the address attack first.
    let actualAddress;
    try {
        if (!paymentOutput.script) {
            return fail('payment-output-wrong-address', 'scriptPubKey not decodable to address');
        }
        actualAddress = btc.Address(scureNetwork).encode(btc.OutScript.decode(paymentOutput.script));
    }
    catch {
        return fail('payment-output-wrong-address', 'scriptPubKey not decodable to address');
    }
    if (!addressesEquivalent(actualAddress, args.expectedSellerPaymentAddress, args.network ?? network_1.Network.Mainnet)) {
        return fail('payment-output-wrong-address', `expected ${args.expectedSellerPaymentAddress}, got ${actualAddress}`);
    }
    // 6. Seller payment amount. Output 1's value is `priceSats + postageSats`
    //    (ord-parity). The seller's net is what's left after their own input
    //    flows back into the same output — `output1 - sellerInputValue`.
    //    Compare net-to-seller against the caller's floor.
    const paymentOutputValue = Number(paymentOutput.amount ?? 0n);
    const pricePaidSats = paymentOutputValue - sellerInputValueSats;
    if (pricePaidSats < args.floorPriceSats) {
        return fail('wrong-price', `${pricePaidSats} < ${args.floorPriceSats}`);
    }
    return { ok: true, pricePaidSats, postageSats };
}
/**
 * Compare two address strings by re-decoding both to script bytes on
 * the configured network. Tolerant of bech32 case differences (BIP173
 * allows mixed but typically all-lowercase or all-uppercase) and
 * defeats Latin/Cyrillic homoglyph attacks because non-ASCII bytes
 * fail bech32 decoding.
 */
function addressesEquivalent(a, b, network) {
    if (a === b)
        return true;
    try {
        const scureNetwork = (0, network_1.toScureNetwork)(network);
        const decodeA = btc.Address(scureNetwork).decode(a);
        const decodeB = btc.Address(scureNetwork).decode(b);
        const scriptA = btc.OutScript.encode(decodeA);
        const scriptB = btc.OutScript.encode(decodeB);
        if (scriptA.length !== scriptB.length)
            return false;
        for (let i = 0; i < scriptA.length; i++) {
            if (scriptA[i] !== scriptB[i])
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function fail(reason, detail) {
    return { ok: false, reason, detail };
}
function bytesToHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
}
//# sourceMappingURL=cat21-offer.helper.js.map