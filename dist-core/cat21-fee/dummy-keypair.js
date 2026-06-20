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
exports.getDummyKeypair = getDummyKeypair;
exports.getDummyLegacyTransaction = getDummyLegacyTransaction;
const secp256k1_1 = require("@noble/curves/secp256k1");
const base_1 = require("@scure/base");
const btc = __importStar(require("@scure/btc-signer"));
/**
 * Dummy keypair + helper-transaction utilities used only during
 * fee-simulation passes. The private key is a well-known constant
 * (`0x0101…01`) — DO NOT use these helpers in any real signing or
 * broadcast path.
 *
 * Lives in `cat21-fee/` because the only legitimate use is the
 * two-pass fee simulation in `fee-simulation.helper.ts`. Putting
 * the dummy material next to the simulator makes the security
 * boundary obvious: "simulation-only, never broadcast."
 */
const getDummyKeypairResult = {};
/**
 * Deterministic dummy keypair for SIMULATION only. Private key is
 * the hardcoded constant `0x0101…01`; addresses for P2PKH,
 * P2SH-P2WPKH, P2WPKH, P2TR are pre-derived so every Layer-2 input
 * adapter can dummy-sign its matching shape. Cached per network
 * bech32 prefix.
 *
 * **Never broadcast** — the private key is publicly known, so
 * signatures provide zero security.
 *
 * For Taproot inputs use `xOnlyDummyPublicKey`; the ECDSA
 * `dummyPublicKey` will not work.
 */
function getDummyKeypair(network) {
    if (!getDummyKeypairResult[network.bech32]) {
        const dummyPrivateKey = base_1.hex.decode('0101010101010101010101010101010101010101010101010101010101010101');
        const dummyPublicKey = secp256k1_1.secp256k1.getPublicKey(dummyPrivateKey, true);
        // see https://stackoverflow.com/a/72411600
        const xOnlyDummyPublicKey = secp256k1_1.schnorr.getPublicKey(dummyPrivateKey);
        // Legacy address (P2PKH)
        // 1C6Rc3w25VHud3dLDamutaqfKWqhrLRTaD for mainnet
        // btc.getAddress + p2ret.address are typed `string | undefined`; the
        // derivation from a fixed dummy key is deterministic and never returns
        // undefined in practice.
        const addressP2PKH = btc.getAddress('pkh', dummyPrivateKey, network);
        // Nested Segwit (P2SH-P2WPKH)
        // 35LM1A29K95ADiQ8rJ9uEfVZCKffZE4D9i for mainnet
        const p2ret = btc.p2sh(btc.p2wpkh(dummyPublicKey, network), network);
        const addressP2SH_P2WPKH = p2ret.address;
        // Native Seqwit (P2WPKH)
        // bc1q0xcqpzrky6eff2g52qdye53xkk9jxkvrh6yhyw for mainnet
        const addressP2WPKH = btc.getAddress('wpkh', dummyPrivateKey, network);
        // TapRoot KeyPathSpend
        // bc1p33wm0auhr9kkahzd6l0kqj85af4cswn276hsxg6zpz85xe2r0y8syx4e5t for mainnet
        const addressP2TR = btc.getAddress('tr', dummyPrivateKey, network);
        getDummyKeypairResult[network.bech32] = {
            dummyPrivateKey,
            dummyPublicKey,
            xOnlyDummyPublicKey,
            addressP2PKH,
            addressP2SH_P2WPKH,
            addressP2WPKH,
            addressP2TR,
        };
    }
    return getDummyKeypairResult[network.bech32];
}
/**
 * Generates a dummy legacy (P2PKH) transaction for the
 * simulation pass. Used to construct a `nonWitnessUtxo` field on
 * legacy P2PKH funding inputs (scure requires the full previous-tx
 * bytes for legacy inputs, see paulmillr/scure-btc-signer README).
 *
 * The transaction includes a number of outputs equal to the `vout`
 * of the provided `TxnOutput`, each output carrying the same value.
 */
function getDummyLegacyTransaction(txnOutput, network) {
    const { dummyPrivateKey, dummyPublicKey, addressP2PKH } = getDummyKeypair(network);
    const tx = new btc.Transaction();
    // P2WPKH requires no damn nonWitnessUtxo which gives us a signable transaction
    const input = {
        txid: '0000000000000000000000000000000000000000000000000000000000000000',
        index: 0,
        witnessUtxo: {
            script: btc.p2wpkh(dummyPublicKey, network).script,
            amount: BigInt(txnOutput.value * (txnOutput.vout + 1))
        }
    };
    tx.addInput(input);
    // Add outputs based on txnOutput.vout, each output having the same value
    for (let i = 0; i <= txnOutput.vout; i++) {
        tx.addOutputAddress(addressP2PKH, BigInt(txnOutput.value), network);
    }
    // Sign the input with the dummy private key
    tx.signIdx(dummyPrivateKey, 0);
    tx.finalize();
    return tx;
}
//# sourceMappingURL=dummy-keypair.js.map