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
exports.buildInputScript = buildInputScript;
const btc = __importStar(require("@scure/btc-signer"));
const address_format_1 = require("./address-format");
const dummy_keypair_1 = require("../cat21-fee/dummy-keypair");
/**
 * Build the scure script for a payment input.
 *
 * The decision is:
 *   - Look at `paymentAddress` → derive the script type.
 *   - For Taproot: ensure the pubkey is x-only (32 bytes) — strip
 *     the parity byte if a 33-byte compressed key was supplied.
 *   - If `isSimulation`, swap in the dummy keypair before any of
 *     the above (Taproot simulation uses the schnorr-derived x-only
 *     dummy; non-taproot uses the compressed dummy).
 *
 * That's the whole algorithm. No per-wallet branching, anywhere.
 */
function buildInputScript(args) {
    const format = (0, address_format_1.getAddressFormat)(args.paymentAddress);
    // Simulation: swap the real pubkey for the SDK's dummy. The
    // schnorr-derived `xOnlyDummyPublicKey` matters for Taproot
    // because it has the y-coordinate parity normalised — a plain
    // `dummyPublicKey.slice(1, 33)` would not.
    let pubkey = args.paymentPublicKey;
    if (args.isSimulation) {
        const dummy = (0, dummy_keypair_1.getDummyKeypair)(args.network);
        pubkey = format === 'P2TR' ? dummy.xOnlyDummyPublicKey : dummy.dummyPublicKey;
    }
    switch (format) {
        case 'P2PKH':
            return { scriptData: btc.p2pkh(pubkey, args.network), tapInternalKey: undefined };
        case 'P2SH???':
            // Treat ANY P2SH address as P2SH-wrapped Segwit (P2SH-P2WPKH).
            // This is the same assumption Xverse and Unisat made for years
            // — there's no on-chain way to distinguish P2SH-P2WPKH from
            // other P2SH variants from the address alone, and every wallet
            // that exposes a P2SH payment address in this SDK uses Nested
            // SegWit. P2SH-multisig or other P2SH variants would need a
            // separate code path; none of the supported wallets ship them.
            return {
                scriptData: btc.p2sh(btc.p2wpkh(pubkey, args.network), args.network),
                tapInternalKey: undefined,
            };
        case 'P2WPKH':
            return { scriptData: btc.p2wpkh(pubkey, args.network), tapInternalKey: undefined };
        case 'P2TR': {
            // Normalise to 32-byte x-only. Wallets that already hand us 32
            // bytes get a no-op; wallets that send 33-byte compressed get
            // the parity byte stripped.
            const xOnly = pubkey.length === 32 ? pubkey : (0, address_format_1.toXOnly)(pubkey);
            return {
                scriptData: btc.p2tr(xOnly, undefined, args.network, true),
                tapInternalKey: xOnly,
            };
        }
    }
}
//# sourceMappingURL=build-input-script.js.map