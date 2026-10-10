import type { BrowserContext } from '@playwright/test';
/**
 * UniSat's wallet API on every network it knows: `wallet-api.unisat.space` and
 * `wallet-api.unisat.io` for mainnet (the extension's `endpoints` list, tried
 * in that order), plus the `-testnet`, `-signet`, `-fractal` variants it
 * switches to with the network.
 */
export declare const UNISAT_WALLET_API: RegExp;
/**
 * `POST /v5/tx/decode2`, answered from the PSBT itself.
 *
 * With this request unanswered the sign popup never shows its Sign button, so
 * it cannot be aborted like an unknown endpoint. Field by field it is what the server returned
 * for every regtest PSBT the unisat-* specs sent it: the prevout and output
 * scripts encoded as MAINNET addresses (the wallet is mainnet), no assets, no
 * risks, `onchain: false` and every `utxoStatus` flag false because the coins
 * exist only on regtest, `sighashType` only on inputs whose PSBT field sets it,
 * `features.rbf` when an input signals BIP-125 (sequence below 0xfffffffe).
 * `isCompleted: true` and `recommendedFeeRate: 1` are the constants of every
 * captured answer. `feeRate` is display text: the fee over the size of the
 * unsigned transaction (no witness yet), so it reads above the final rate.
 * `shouldWarnFeeRate` is false, which keeps the popup's default styling.
 */
export declare function decodeUnisatPsbt(psbtHex: string): unknown;
/**
 * The answer for one wallet-API request, or `null` for an endpoint with no
 * captured answer.
 */
export declare function unisatOfflineAnswer(url: URL, postData?: string | null): unknown | null;
/**
 * Keep UniSat's vendor backend out of the test: every request to its wallet
 * API is answered locally, the way a working server answers an empty wallet.
 *
 * The extension gates its UI on that API. The connect approval renders a
 * spinner until `POST /v5/default/check-website` for the requesting origin
 * resolves, and its `.then()` has no rejection branch, so when the API hangs,
 * fails or answers with an error page the popup stays a spinner and never
 * mounts its Connect button. The extension's own client gives each attempt
 * 30 s and retries three times. The sign popup waits on `tx/decode2` the same
 * way. With the API live, every spec that connects or signs passes or fails
 * on the vendor's availability, not on ours.
 *
 * An endpoint with no captured answer is aborted, so a new dependency fails at
 * once and is listed by `recordWalletBackendRequests` rather than waiting on a
 * live server.
 *
 * Install right after the context launches, before onboarding. The requests
 * the service worker sends while the extension starts, before this is
 * installed, still reach the network; the whole unisat lane passes with the
 * API unreachable, so none of them gates a popup.
 */
export declare function installUnisatOfflineRoutes(context: BrowserContext): Promise<void>;
//# sourceMappingURL=unisat-offline-routes.d.ts.map