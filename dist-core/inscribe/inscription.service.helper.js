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
exports.createInscribeTransactions = createInscribeTransactions;
const secp256k1_1 = require("@noble/curves/secp256k1");
const btc = __importStar(require("@scure/btc-signer"));
const dummy_keypair_1 = require("../cat21-fee/dummy-keypair");
const address_format_1 = require("../cat21-script/address-format");
const network_1 = require("../network");
const inscription_commit_helper_1 = require("./inscription-commit.helper");
const inscription_envelope_1 = require("./inscription-envelope");
const inscription_input_adapter_1 = require("./inscription-input-adapter");
const inscription_reveal_helper_1 = require("./inscription-reveal.helper");
const inscription_fee_helper_1 = require("./inscription-fee.helper");
/**
 * Build the inscribe commit + reveal pair for the given content.
 * Pure function modulo `randomPrivateKey`.
 *
 * The returned `ephemeral.privKey` is the bearer instrument for
 * the commit output — see the module-level lifecycle note for the
 * storage semantic.
 */
function createInscribeTransactions(args) {
    if (args.feeRatePerVbyte <= 0) {
        throw new Error('feeRatePerVbyte must be positive');
    }
    if (args.tip !== undefined) {
        if (!Number.isInteger(args.tip.value) || args.tip.value < 0) {
            throw new Error('tip.value must be a non-negative integer');
        }
        if (typeof args.tip.address !== 'string' || args.tip.address.length === 0) {
            throw new Error('tip.address must be a non-empty string');
        }
    }
    const ephemeralPrivKey = secp256k1_1.secp256k1.utils.randomPrivateKey();
    const ephemeralPubkeyXonly = (0, inscription_reveal_helper_1.deriveRevealPubkeyXonly)(ephemeralPrivKey);
    // Synthesise envelope fields from the convenience args (note,
    // contentEncoding) and prepend to the caller-supplied list. The
    // caller's own envelopeFields entries always win on duplicate
    // tags (preserved order, ord decoder indexes by tag occurrence).
    const autoFields = [];
    if (args.parent !== undefined) {
        autoFields.push({ tag: inscription_envelope_1.ORD_TAGS.parent, value: (0, inscription_envelope_1.encodeParentInscriptionId)(args.parent) });
    }
    if (args.note !== undefined) {
        autoFields.push({ tag: inscription_envelope_1.ORD_TAGS.note, value: new TextEncoder().encode(args.note) });
    }
    if (args.contentEncoding === 'br') {
        autoFields.push({ tag: inscription_envelope_1.ORD_TAGS.content_encoding, value: new TextEncoder().encode('br') });
    }
    const mergedFields = autoFields.length === 0
        ? (args.envelopeFields ?? [])
        : [...autoFields, ...(args.envelopeFields ?? [])];
    const envelope = (0, inscription_envelope_1.buildInscriptionEnvelope)({
        revealPubkeyXonly: ephemeralPubkeyXonly,
        contentType: args.contentType,
        body: args.body,
        fields: mergedFields,
    });
    // Layer-2: convert raw UTXO into the funding-input shape the
    // commit helper expects. Real-mode (not simulation) so the
    // funding gets signed by the real wallet later.
    const realFundingInput = (0, inscription_input_adapter_1.prepareInscribeFundingInput)({
        utxo: args.paymentOutput,
        paymentPublicKey: args.paymentPublicKey,
        paymentAddress: args.paymentAddress,
        isSimulation: false,
        network: args.network,
    });
    // Layer-3: simulate fees. Layer 3 uses its own simulation-mode
    // funding input via the dummy keypair pattern.
    const simulationFundingInput = (0, inscription_input_adapter_1.prepareInscribeFundingInput)({
        utxo: args.paymentOutput,
        paymentPublicKey: args.paymentPublicKey,
        paymentAddress: args.paymentAddress,
        isSimulation: true,
        network: args.network,
    });
    let fees;
    try {
        fees = (0, inscription_fee_helper_1.simulateInscribeFees)({
            feeRatePerVbyte: args.feeRatePerVbyte,
            body: args.body,
            contentType: args.contentType,
            envelopeFields: mergedFields,
            fundingInput: simulationFundingInput,
            senderChangeAddress: args.paymentAddress,
            recipientAddress: args.recipientAddress,
            ephemeralPubkeyXonly,
            tip: args.tip,
            walletType: args.walletType,
            network: args.network,
        });
    }
    catch (err) {
        // The commit helper throws `Funding insufficient: ...` when the
        // funding UTXO is below the postage + fees floor. Re-cast to
        // the orchestrator's typed message so consumers can branch on it
        // (same translation pattern cat21's createTransaction uses).
        if (err instanceof Error && /Funding insufficient/.test(err.message)) {
            throw new Error('Insufficient funds for inscribe');
        }
        throw err;
    }
    if (args.paymentOutput.value < fees.fundingRequirementSats) {
        throw new Error(`Insufficient funds for inscribe: funding UTXO has ${args.paymentOutput.value} ` +
            `sats, need ${fees.fundingRequirementSats} ` +
            `(commit fee ${fees.commitFeeSats} + commit output value ` +
            `${fees.commitOutputValueSats})`);
    }
    // Layer-1 build at resolved fees.
    const changeDustLimitSats = changeDustLimitFor(args.paymentAddress);
    const commit = (0, inscription_commit_helper_1.buildInscribeCommitPsbt)({
        fundingInput: realFundingInput,
        senderChangeAddress: args.paymentAddress,
        envelopeScript: envelope,
        ephemeralPubkeyXonly,
        commitFeeSats: fees.commitFeeSats,
        revealFeeReserveSats: fees.revealFeeSats,
        tipValueSats: args.tip?.value,
        walletType: args.walletType,
        changeDustLimitSats,
        network: args.network,
    });
    // The reveal's input outpoint references the commit's txid.
    // scure 1.2.x's `.id` requires a finalized tx; the real commit
    // is unsigned because the user's wallet hasn't signed yet. We
    // build a SIMULATION-mode commit at the same fees against the
    // dummy-keyed funding input, dummy-sign it, finalize, read its
    // txid. SegWit txid is witness-independent, so the sim txid
    // equals what the wallet-signed real commit will produce
    // byte-for-byte at the same inputs/outputs.
    const simCommit = (0, inscription_commit_helper_1.buildInscribeCommitPsbt)({
        fundingInput: simulationFundingInput,
        senderChangeAddress: args.paymentAddress,
        envelopeScript: envelope,
        ephemeralPubkeyXonly,
        commitFeeSats: fees.commitFeeSats,
        revealFeeReserveSats: fees.revealFeeSats,
        tipValueSats: args.tip?.value,
        walletType: args.walletType,
        changeDustLimitSats,
        network: args.network,
    });
    const simTx = btc.Transaction.fromPSBT(simCommit.commitPsbt);
    const { dummyPrivateKey } = (0, dummy_keypair_1.getDummyKeypair)((0, network_1.toScureNetwork)(args.network));
    simTx.signIdx(dummyPrivateKey, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
    simTx.finalize();
    const commitTxidUnsigned = simTx.id;
    const reveal = (0, inscription_reveal_helper_1.buildInscribeRevealTx)({
        commitTxid: commitTxidUnsigned,
        commitVout: 0,
        commitOutputValueSats: commit.commitOutputValueSats,
        commitOutputScript: commit.commitOutputScript,
        taproot: {
            internalKey: commit.taproot.internalKey,
            tapLeafScript: commit.taproot.tapLeafScript,
        },
        ephemeralPrivKey,
        recipientAddress: args.recipientAddress,
        tip: args.tip,
        network: args.network,
    });
    return {
        commitPsbt: commit.commitPsbt,
        commitTxid: commitTxidUnsigned,
        revealHex: reveal.revealHex,
        revealTxid: reveal.revealTxid,
        commitAddress: commit.commitAddress,
        fees,
        ephemeral: {
            privKey: ephemeralPrivKey,
            pubkeyXonly: ephemeralPubkeyXonly,
        },
        commit: {
            outputScript: commit.commitOutputScript,
            outputValueSats: commit.commitOutputValueSats,
            envelopeScript: envelope,
        },
    };
}
/** Per-address-type dust limit, mirroring `getMinimumUtxoSize`. */
function changeDustLimitFor(address) {
    const fmt = (0, address_format_1.getAddressFormat)(address);
    switch (fmt) {
        case 'P2TR': return 330;
        case 'P2WPKH': return 294;
        case 'P2SH???':
        case 'P2PKH': return 546;
    }
}
//# sourceMappingURL=inscription.service.helper.js.map