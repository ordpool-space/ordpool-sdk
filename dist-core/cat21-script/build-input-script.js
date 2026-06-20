import * as btc from '@scure/btc-signer';
import { getAddressFormat, toXOnly } from './address-format';
import { getDummyKeypair } from '../cat21-fee/dummy-keypair';
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
export function buildInputScript(args) {
    const format = getAddressFormat(args.paymentAddress);
    // Simulation: swap the real pubkey for the SDK's dummy. The
    // schnorr-derived `xOnlyDummyPublicKey` matters for Taproot
    // because it has the y-coordinate parity normalised — a plain
    // `dummyPublicKey.slice(1, 33)` would not.
    let pubkey = args.paymentPublicKey;
    if (args.isSimulation) {
        const dummy = getDummyKeypair(args.network);
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
            const xOnly = pubkey.length === 32 ? pubkey : toXOnly(pubkey);
            return {
                scriptData: btc.p2tr(xOnly, undefined, args.network, true),
                tapInternalKey: xOnly,
            };
        }
    }
}
//# sourceMappingURL=build-input-script.js.map