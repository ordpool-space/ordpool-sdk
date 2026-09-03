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
//# sourceMappingURL=wizz-offline-routes.d.ts.map