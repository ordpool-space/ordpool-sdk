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
exports.buildInscribeRevealTx = buildInscribeRevealTx;
exports.deriveRevealPubkeyXonly = deriveRevealPubkeyXonly;
const btc = __importStar(require("@scure/btc-signer"));
const secp256k1_1 = require("@noble/curves/secp256k1");
const network_1 = require("../network");
const inscription_commit_helper_1 = require("./inscription-commit.helper");
/**
 * Signs the reveal via the envelope tapscript leaf, returns the
 * finalized reveal hex. The caller-supplied ephemeral private key
 * is used for the Schnorr signature; the orchestrator returns this
 * same key on its result so the consumer can rebuild a different
 * reveal later under different parameters.
 */
function buildInscribeRevealTx(args) {
    const scureNetwork = (0, network_1.toScureNetwork)(args.network);
    const postageSats = inscription_commit_helper_1.INSCRIBE_POSTAGE_SATS;
    const tipValueSats = args.tip?.value ?? 0;
    if (tipValueSats < 0)
        throw new Error('tip.value must be non-negative');
    if (!Number.isInteger(tipValueSats))
        throw new Error('tip.value must be an integer');
    // The reveal's miner fee equals the leftover: commit output sats
    // minus the postage going to the recipient minus any tip output
    // going to the tip address.
    const revealFeeReserveSats = args.commitOutputValueSats - postageSats - tipValueSats;
    if (revealFeeReserveSats < 0) {
        throw new Error(`commitOutputValueSats (${args.commitOutputValueSats}) < postage (${postageSats}) + tip (${tipValueSats})`);
    }
    if (args.ephemeralPrivKey.length !== 32) {
        throw new Error(`ephemeralPrivKey must be 32 bytes; got ${args.ephemeralPrivKey.length}`);
    }
    // `lockTime: 21` on the reveal too — both the commit AND the reveal
    // qualify as CAT-21 mints under cat21-ord's `--index-cat21` rule
    // (`nLockTime === 21`). That mints TWO cats per inscription:
    //
    //   1. Cat from the commit (id `<commitTxid>i0`) at the first sat
    //      of commit's vout[0]. The reveal spends commit's vout[0]
    //      FIFO-style, so this cat moves to the inscription recipient's
    //      UTXO (vout[0] of the reveal at 546 sats).
    //   2. Cat from the reveal (id `<revealTxid>i0`) at the first sat
    //      of reveal's vout[0] — the same UTXO and the same sat as
    //      cat #1. Post-jubilee chains (regtest above block 110;
    //      mainnet above 824544) tag this cat with the `Vindicated`
    //      charm because it's technically a reinscription on the same
    //      sat. The charm is metadata; the cat is fully real, has a
    //      positive cat number, and indexes normally.
    //
    // Net: one inscription, two cats stacked on the same 546-sat UTXO
    // at the inscription recipient. The maintainer's call: "there are
    // never enough cats".
    const tx = new btc.Transaction({ disableScriptCheck: true, lockTime: 21 });
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
    // Output 1 (optional): tip output. ord's first-sat-of-first-output
    // rule pins the inscription to vout[0]; the tip lives at vout[1].
    // Pattern matches `0xFlicker/ordinals` packages/inscriptions/src/
    // reveal.ts (the only OSS inscriber with a tip primitive — see
    // /Work/ordpool/OSS-INSCRIBERS.md). We diverge in that we ship a
    // single fixed-sats tip, not a weighted multi-recipient split.
    if (args.tip !== undefined && tipValueSats > 0) {
        tx.addOutputAddress(args.tip.address, BigInt(tipValueSats), scureNetwork);
    }
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
    //
    // scure stores each `tapLeafScript[i]` value as the BIP-371
    // concatenation `<bareScript><leafVersionByte>` (see scure
    // `index.js:1280-1283`: `concat(l.script, [l.version || TAP_LEAF_VERSION])`).
    // The trailing version byte MUST be stripped before the script
    // is used in the BIP-341 sighash AND before it goes into the
    // witness — both validators reconstruct the leaf hash from the
    // bare-script bytes only. scure's own sign path strips it the
    // same way (`index.js:2352`: `_script.subarray(0, -1)`).
    const [cbStruct, leafScriptWithVersion] = args.taproot.tapLeafScript[0];
    const bareLeafScript = leafScriptWithVersion.subarray(0, -1);
    const leafVersion = leafScriptWithVersion[leafScriptWithVersion.length - 1] ?? 0xc0;
    const sighash = tx.preimageWitnessV1(0, [args.commitOutputScript], btc.SignatureHash.DEFAULT, [BigInt(args.commitOutputValueSats)], undefined, bareLeafScript, leafVersion);
    const signature = secp256k1_1.schnorr.sign(sighash, args.ephemeralPrivKey);
    const controlBlock = btc.TaprootControlBlock.encode(cbStruct);
    tx.updateInput(0, {
        finalScriptWitness: [signature, bareLeafScript, controlBlock],
    }, true);
    if (tx.lockTime !== 21) {
        throw new Error(`Internal error: reveal lockTime=${tx.lockTime}, expected 21`);
    }
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
function deriveRevealPubkeyXonly(privKey) {
    return secp256k1_1.schnorr.getPublicKey(privKey);
}
//# sourceMappingURL=inscription-reveal.helper.js.map