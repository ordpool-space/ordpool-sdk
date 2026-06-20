import * as btc from '@scure/btc-signer';
/**
 * Universal input-script builder. Dispatches purely on the
 * `paymentAddress` format — no wallet-name switch. Any wallet
 * produces a correct input shape as long as it returns a payment
 * address + pubkey. Taproot x-only normalisation happens at runtime
 * from the pubkey's length (32 vs 33 bytes).
 *
 * Pure. Used by every CAT-21 Layer-2 adapter (mint, transfer, offer).
 */
export interface BuildInputScriptArgs {
    paymentAddress: string;
    /**
     * Payment public key from the wallet's `getAddresses`-equivalent
     * call. ALL wallets agree on:
     *   - 33-byte compressed for non-taproot inputs
     *   - 32-byte x-only OR 33-byte compressed for taproot (the SDK
     *     normalises by stripping the parity byte when 33 bytes are
     *     supplied; the wallet handed us either form depending on its
     *     convention).
     */
    paymentPublicKey: Uint8Array;
    /**
     * Simulation mode: swap the supplied pubkey for the SDK's
     * well-known dummy keypair so vsize is observable during the
     * two-pass fee simulation without exposing the user's key.
     * NEVER use the result of a simulation build for real signing.
     */
    isSimulation: boolean;
    network: typeof btc.NETWORK;
}
export interface BuildInputScriptResult {
    /**
     * Scure script object — `P2Ret` for everything except Taproot,
     * `P2TROut` for Taproot. Both expose `script` (the scriptPubKey)
     * and Taproot additionally exposes the script-path tweaks the
     * adapter merges into the input.
     */
    scriptData: btc.P2Ret | btc.P2TROut;
    /**
     * Only set for Taproot — the x-only internal key the adapter
     * attaches to the input so a key-path signer produces a valid
     * Schnorr signature. `undefined` for every other address format.
     */
    tapInternalKey: Uint8Array | undefined;
}
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
export declare function buildInputScript(args: BuildInputScriptArgs): BuildInputScriptResult;
//# sourceMappingURL=build-input-script.d.ts.map