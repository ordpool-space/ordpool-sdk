import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { getDummyKeypair } from '../cat21-fee/dummy-keypair';
import { getAddressFormat } from '../cat21-script/address-format';
import { toScureNetwork } from '../network';
import { buildInscribeCommitPsbt, } from './inscription-commit.helper';
import { buildInscriptionEnvelope, } from './inscription-envelope';
import { prepareInscribeFundingInput, } from './inscription-input-adapter';
import { buildInscribeRevealTx, deriveRevealPubkeyXonly, } from './inscription-reveal.helper';
import { simulateInscribeFees, } from './inscription-fee.helper';
/**
 * Build the inscribe commit + reveal pair for the given content.
 * Pure function modulo `randomPrivateKey`.
 *
 * The returned `ephemeral.privKey` is the bearer instrument for
 * the commit output — see the module-level lifecycle note for the
 * storage semantic.
 */
export function createInscribeTransactions(args) {
    if (args.feeRatePerVbyte <= 0) {
        throw new Error('feeRatePerVbyte must be positive');
    }
    const ephemeralPrivKey = secp256k1.utils.randomPrivateKey();
    const ephemeralPubkeyXonly = deriveRevealPubkeyXonly(ephemeralPrivKey);
    const envelope = buildInscriptionEnvelope({
        revealPubkeyXonly: ephemeralPubkeyXonly,
        contentType: args.contentType,
        body: args.body,
        fields: args.envelopeFields,
    });
    // Layer-2: convert raw UTXO into the funding-input shape the
    // commit helper expects. Real-mode (not simulation) so the
    // funding gets signed by the real wallet later.
    const realFundingInput = prepareInscribeFundingInput({
        utxo: args.paymentOutput,
        paymentPublicKey: args.paymentPublicKey,
        paymentAddress: args.paymentAddress,
        isSimulation: false,
        network: args.network,
    });
    // Layer-3: simulate fees. Layer 3 uses its own simulation-mode
    // funding input via the dummy keypair pattern.
    const simulationFundingInput = prepareInscribeFundingInput({
        utxo: args.paymentOutput,
        paymentPublicKey: args.paymentPublicKey,
        paymentAddress: args.paymentAddress,
        isSimulation: true,
        network: args.network,
    });
    let fees;
    try {
        fees = simulateInscribeFees({
            feeRatePerVbyte: args.feeRatePerVbyte,
            body: args.body,
            contentType: args.contentType,
            envelopeFields: args.envelopeFields,
            fundingInput: simulationFundingInput,
            senderChangeAddress: args.paymentAddress,
            recipientAddress: args.recipientAddress,
            ephemeralPubkeyXonly,
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
    const commit = buildInscribeCommitPsbt({
        fundingInput: realFundingInput,
        senderChangeAddress: args.paymentAddress,
        envelopeScript: envelope,
        ephemeralPubkeyXonly,
        commitFeeSats: fees.commitFeeSats,
        revealFeeReserveSats: fees.revealFeeSats,
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
    const simCommit = buildInscribeCommitPsbt({
        fundingInput: simulationFundingInput,
        senderChangeAddress: args.paymentAddress,
        envelopeScript: envelope,
        ephemeralPubkeyXonly,
        commitFeeSats: fees.commitFeeSats,
        revealFeeReserveSats: fees.revealFeeSats,
        changeDustLimitSats,
        network: args.network,
    });
    const simTx = btc.Transaction.fromPSBT(simCommit.commitPsbt);
    const { dummyPrivateKey } = getDummyKeypair(toScureNetwork(args.network));
    simTx.signIdx(dummyPrivateKey, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
    simTx.finalize();
    const commitTxidUnsigned = simTx.id;
    const reveal = buildInscribeRevealTx({
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
    const fmt = getAddressFormat(address);
    switch (fmt) {
        case 'P2TR': return 330;
        case 'P2WPKH': return 294;
        case 'P2SH???':
        case 'P2PKH': return 546;
    }
}
//# sourceMappingURL=inscription.service.helper.js.map