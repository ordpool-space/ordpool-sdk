import { BrowserContext } from '@playwright/test';
/**
 * Make every Wizz popup hermetic: intercept the wallet's fleet of LIVE
 * third-party backends and answer each with the truthful "empty" result.
 *
 * Wizz (a Unisat fork, mainnet-only) will NOT enable the Sign button in
 * its approval popup until it has loaded the account balance AND
 * analysed the PSBT for atomicals/runes. It does that against its own
 * ep.wizz.cash (Atomicals ElectrumX proxy) + ordx.wizz.cash (runes
 * indexer), plus wallet-api.unisat.io and api.rgbpp.io. If ANY of them
 * throws, the popup shows "Failed to load balance" and Sign stays
 * disabled forever. In CI they are flaky, and when Wizz's own backend is
 * down they 503 for everyone. Nothing here is real on regtest (no
 * atomicals, no runes, no rgbpp assets), so the run must depend only on
 * the local regtest stack, never on Wizz's server uptime.
 *
 * Response shapes are reverse-engineered from the Wizz bundle (ui.js)
 * and verified against WizzWallet/elex-proxy `R::ok`; the unisat + rgbpp
 * envelopes are copied verbatim from real 200 responses captured in CI
 * traces. Canonical copy: consumers (e.g. cubes-frontend) import this
 * from `ordpool-sdk/e2e` instead of keeping their own.
 */
export declare function installWizzOfflineRoutes(context: BrowserContext): Promise<void>;
/** One request a wallet popup made, as recorded by {@link recordWalletBackendRequests}. */
export interface RecordedBackendRequest {
    method: string;
    url: string;
    /** Response status, or null when the request failed outright. */
    status: number | null;
    /** POST body, truncated. The decode endpoints carry the PSBT here. */
    postData?: string;
}
/**
 * Record every off-box request a wallet popup makes, so two flows can be
 * diffed instead of guessed at.
 *
 * This is the tool for "operation A signs fine and operation B leaves the Sign
 * button disabled". Both flows are recorded and the difference names the call
 * the stub does not answer, which beats varying a protocol constant to infer
 * it: a diagnostic that changes the thing under test tells you less, and a
 * postage size is not ours to vary even temporarily.
 *
 * Pure observation. It attaches listeners rather than routes, so it cannot
 * change which handler wins or perturb the behaviour being measured. Localhost
 * is filtered out, leaving only the wallet's own backends.
 */
export declare function recordWalletBackendRequests(context: BrowserContext): {
    requests: RecordedBackendRequest[];
    hosts(): string[];
};
//# sourceMappingURL=wizz-offline-routes.d.ts.map