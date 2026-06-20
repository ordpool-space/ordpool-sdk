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
exports.twoPassFeeSimulation = void 0;
exports.simulateInscribeFees = simulateInscribeFees;
const btc = __importStar(require("@scure/btc-signer"));
const dummy_keypair_1 = require("../cat21-fee/dummy-keypair");
const fee_simulation_helper_1 = require("../cat21-fee/fee-simulation.helper");
const network_1 = require("../network");
const inscription_commit_helper_1 = require("./inscription-commit.helper");
const inscription_envelope_1 = require("./inscription-envelope");
const inscription_reveal_helper_1 = require("./inscription-reveal.helper");
/**
 * Returns the commit + reveal fee math at the given fee rate.
 * Pure function — does not broadcast, does not retain any key
 * material between calls.
 */
function simulateInscribeFees(args) {
    if (args.feeRatePerVbyte <= 0) {
        throw new Error('feeRatePerVbyte must be positive');
    }
    if (args.ephemeralPubkeyXonly.length !== 32) {
        throw new Error(`ephemeralPubkeyXonly must be 32 bytes; got ${args.ephemeralPubkeyXonly.length}`);
    }
    // The simulator uses a deterministic dummy ephemeral private key
    // for the reveal-signing step (the resulting Schnorr signature is
    // always 64 bytes regardless of the key bytes, so vsize doesn't
    // care). The pubkey embedded in the envelope + used as taproot
    // internal key is whatever the caller passed (real orchestrator
    // passes the freshly-generated ephemeral key; specs may pass a
    // fixed dummy).
    const dummyEphemeralPriv = new Uint8Array(32).fill(0x42);
    const envelope = (0, inscription_envelope_1.buildInscriptionEnvelope)({
        revealPubkeyXonly: args.ephemeralPubkeyXonly,
        contentType: args.contentType,
        body: args.body,
        fields: args.envelopeFields,
    });
    // ---- Step 1: reveal vsize is deterministic; compute once. ----
    // We need the commit output's script/address first to construct
    // a reveal that points at it. Build a placeholder commit with
    // zero fees just to get the taptree metadata.
    const placeholderCommit = (0, inscription_commit_helper_1.buildInscribeCommitPsbt)({
        fundingInput: args.fundingInput,
        senderChangeAddress: args.senderChangeAddress,
        envelopeScript: envelope,
        ephemeralPubkeyXonly: args.ephemeralPubkeyXonly,
        commitFeeSats: 0,
        revealFeeReserveSats: 0,
        changeDustLimitSats: args.changeDustLimitSats,
        network: args.network,
    });
    const reveal = (0, inscription_reveal_helper_1.buildInscribeRevealTx)({
        commitTxid: '0'.repeat(64),
        commitVout: 0,
        commitOutputValueSats: inscription_commit_helper_1.INSCRIBE_POSTAGE_SATS,
        commitOutputScript: placeholderCommit.commitOutputScript,
        taproot: {
            internalKey: placeholderCommit.taproot.internalKey,
            tapLeafScript: placeholderCommit.taproot.tapLeafScript,
        },
        ephemeralPrivKey: dummyEphemeralPriv,
        recipientAddress: args.recipientAddress,
        network: args.network,
    });
    const revealVsize = reveal.revealVsize;
    const revealFeeSats = Math.ceil(revealVsize * args.feeRatePerVbyte);
    // ---- Step 2: commit two-pass with revealFeeReserve = revealFeeSats. ----
    // Reuse the existing twoPassFeeSimulation pattern.
    const { finalFeeSats: commitFeeSats, vsize: commitVsize, finalSimulation } = (0, fee_simulation_helper_1.twoPassFeeSimulation)({
        feeRatePerVbyte: args.feeRatePerVbyte,
        simulate: (feeSats) => {
            const commit = (0, inscription_commit_helper_1.buildInscribeCommitPsbt)({
                fundingInput: args.fundingInput,
                senderChangeAddress: args.senderChangeAddress,
                envelopeScript: envelope,
                ephemeralPubkeyXonly: args.ephemeralPubkeyXonly,
                commitFeeSats: feeSats,
                revealFeeReserveSats: revealFeeSats,
                changeDustLimitSats: args.changeDustLimitSats,
                network: args.network,
            });
            // Decode the PSBT, dummy-sign the funding input, finalize,
            // read vsize. Same pattern cat21's simulateTransaction uses
            // (cat21.service.ts:176). Allows both DEFAULT and ALL
            // sighash because the funding input is taproot when the
            // caller passes a Taproot wallet via the Layer-2 adapter's
            // simulation mode.
            const tx = btc.Transaction.fromPSBT(commit.commitPsbt);
            const { dummyPrivateKey } = (0, dummy_keypair_1.getDummyKeypair)((0, network_1.toScureNetwork)(args.network));
            tx.signIdx(dummyPrivateKey, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
            tx.finalize();
            return { vsize: tx.vsize, commit };
        },
    });
    const commitOutputValueSats = finalSimulation.commit.commitOutputValueSats;
    return {
        commitFeeSats,
        revealFeeSats,
        totalFeeSats: commitFeeSats + revealFeeSats,
        commitVsize,
        revealVsize,
        combinedVsize: commitVsize + revealVsize,
        commitOutputValueSats,
        fundingRequirementSats: commitOutputValueSats + commitFeeSats,
    };
}
/**
 * Re-exports for consumers that want the underlying primitive.
 */
var fee_simulation_helper_2 = require("../cat21-fee/fee-simulation.helper");
Object.defineProperty(exports, "twoPassFeeSimulation", { enumerable: true, get: function () { return fee_simulation_helper_2.twoPassFeeSimulation; } });
//# sourceMappingURL=inscription-fee.helper.js.map