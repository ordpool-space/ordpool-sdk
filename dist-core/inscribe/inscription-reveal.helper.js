import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';
import { toScureNetwork } from '../network';
import { INSCRIBE_POSTAGE_SATS } from './inscription-commit.helper';
/**
 * Signs the reveal via the envelope tapscript leaf, returns the
 * finalized reveal hex. The caller-supplied ephemeral private key
 * is used for the Schnorr signature; the orchestrator returns this
 * same key on its result so the consumer can rebuild a different
 * reveal later under different parameters.
 */
export function buildInscribeRevealTx(args) {
    const scureNetwork = toScureNetwork(args.network);
    const postageSats = INSCRIBE_POSTAGE_SATS;
    const revealFeeReserveSats = args.commitOutputValueSats - postageSats;
    if (revealFeeReserveSats < 0) {
        throw new Error(`commitOutputValueSats (${args.commitOutputValueSats}) < postage (${postageSats})`);
    }
    if (args.ephemeralPrivKey.length !== 32) {
        throw new Error(`ephemeralPrivKey must be 32 bytes; got ${args.ephemeralPrivKey.length}`);
    }
    const tx = new btc.Transaction({ disableScriptCheck: true });
    // Input 0: commit P2TR output, spent via the envelope leaf.
    // Envelope leaf is index 0 of the args.taproot.tapLeafScript array.
    tx.addInput({
        txid: args.commitTxid,
        index: args.commitVout,
        witnessUtxo: {
            script: args.commitOutputScript,
            amount: BigInt(args.commitOutputValueSats),
        },
        tapInternalKey: args.taproot.internalKey,
        tapLeafScript: args.taproot.tapLeafScript,
    });
    // Output 0: recipient address, postage sats. The inscription
    // lands on the first sat of this output (ord-theory FIFO).
    tx.addOutputAddress(args.recipientAddress, BigInt(postageSats), scureNetwork);
    // Manual taproot tapscript-path finalization.
    //
    // scure 1.2.x's automatic finalize rejects our envelope tapscript
    // pattern (`<pubkey> CHECKSIG OP_FALSE OP_IF "ord" ... OP_ENDIF`)
    // because it's not one of the known `pk` / `ms` patterns — it
    // throws "Finalize: Unknown tapLeafScript". scure 2.x added
    // `customScripts` to register handlers; we don't have that.
    //
    // Manual path mirrors what scure's finalize would do for a `pk`
    // leaf: compute the BIP-341 tapscript sighash, sign with the
    // ephemeral Schnorr key, assemble `[sig, script, controlBlock]`
    // as the witness, write it via updateInput. The output is
    // byte-identical to what a scure-2.x customScripts handler
    // would produce.
    const [cbStruct, leafScript] = args.taproot.tapLeafScript[0];
    const leafVersion = cbStruct.version ?? 0xc0;
    const sighash = tx.preimageWitnessV1(0, [args.commitOutputScript], btc.SignatureHash.DEFAULT, [BigInt(args.commitOutputValueSats)], undefined, leafScript, leafVersion);
    const signature = schnorr.sign(sighash, args.ephemeralPrivKey);
    const controlBlock = btc.TaprootControlBlock.encode(cbStruct);
    tx.updateInput(0, {
        finalScriptWitness: [signature, leafScript, controlBlock],
    }, true);
    return {
        revealHex: tx.hex,
        revealTxid: tx.id,
        revealVsize: tx.vsize,
    };
}
/**
 * Derives the x-only Schnorr pubkey from a private key. The pubkey
 * is what gets embedded in the envelope tapscript via
 * `<revealPubkeyXonly> OP_CHECKSIG`, so the caller can pre-compute
 * the envelope independently of the actual reveal call. The same
 * pubkey is fed to both the commit helper (via envelopeScript) and
 * the reveal helper (implicitly via the regenerated private key).
 *
 * Returns the 32-byte x-only Schnorr pubkey.
 */
export function deriveRevealPubkeyXonly(privKey) {
    return schnorr.getPublicKey(privKey);
}
//# sourceMappingURL=inscription-reveal.helper.js.map