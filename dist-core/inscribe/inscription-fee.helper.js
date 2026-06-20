import * as btc from '@scure/btc-signer';
import { getDummyKeypair } from '../cat21-fee/dummy-keypair';
import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import { toScureNetwork } from '../network';
import { INSCRIBE_POSTAGE_SATS, buildInscribeCommitPsbt } from './inscription-commit.helper';
import { buildInscriptionEnvelope } from './inscription-envelope';
import { buildInscribeRevealTx } from './inscription-reveal.helper';
/**
 * Returns the commit + reveal fee math at the given fee rate.
 * Pure function — does not broadcast, does not retain any key
 * material between calls.
 */
export function simulateInscribeFees(args) {
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
    const envelope = buildInscriptionEnvelope({
        revealPubkeyXonly: args.ephemeralPubkeyXonly,
        contentType: args.contentType,
        body: args.body,
        fields: args.envelopeFields,
    });
    // ---- Step 1: reveal vsize is deterministic; compute once. ----
    // We need the commit output's script/address first to construct
    // a reveal that points at it. Build a placeholder commit with
    // zero fees just to get the taptree metadata.
    const placeholderCommit = buildInscribeCommitPsbt({
        fundingInput: args.fundingInput,
        senderChangeAddress: args.senderChangeAddress,
        envelopeScript: envelope,
        ephemeralPubkeyXonly: args.ephemeralPubkeyXonly,
        commitFeeSats: 0,
        revealFeeReserveSats: 0,
        changeDustLimitSats: args.changeDustLimitSats,
        network: args.network,
    });
    const reveal = buildInscribeRevealTx({
        commitTxid: '0'.repeat(64),
        commitVout: 0,
        commitOutputValueSats: INSCRIBE_POSTAGE_SATS,
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
    const { finalFeeSats: commitFeeSats, vsize: commitVsize, finalSimulation } = twoPassFeeSimulation({
        feeRatePerVbyte: args.feeRatePerVbyte,
        simulate: (feeSats) => {
            const commit = buildInscribeCommitPsbt({
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
            const { dummyPrivateKey } = getDummyKeypair(toScureNetwork(args.network));
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
export { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
//# sourceMappingURL=inscription-fee.helper.js.map