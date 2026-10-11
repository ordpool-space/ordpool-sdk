import type { BrowserContext } from '@playwright/test';
/**
 * Every backend Phantom (v26.16.0) calls from its service worker and its
 * pages, as recorded on the phantom lane, all under `phantom.app`: its API
 * (`api.phantom.app`: account discovery, user profile, wallet storage, the KMS
 * RPC), `auth.phantom.app` (OAuth tokens), `time.phantom.app` (clock sync),
 * `data.phantom.app` (analytics batches), `eppo-proxy.phantom.app` (feature
 * flags), `sanity-proxy-v2.phantom.app` (announcements) and
 * `blowfish-blocklist-proxy.phantom.app` (the dapp blocklist), plus its error
 * reports to Datadog's Sentry intake (`sentry-intake.datadoghq.com`).
 */
export declare const PHANTOM_VENDOR_HOSTS: RegExp;
/**
 * Keep Phantom's vendor backends out of the test: every request to a
 * Phantom host (`PHANTOM_VENDOR_HOSTS`) is aborted at once.
 *
 * None of them gates a flow the specs drive: the phantom lane passes with
 * every host except localhost unreachable. Restoring from the seed, unlocking
 * and the connect request all run inside the extension; without the backends
 * Phantom shows no balances, default feature flags and no announcements. An
 * aborted request fails at once instead of waiting on a live server.
 *
 * Install right after the context launches, before onboarding or the first
 * extension page. Routes cover the service worker as well as the pages. The
 * requests the service worker sends while the extension starts, before this
 * is installed, still reach the network.
 */
export declare function installPhantomOfflineRoutes(context: BrowserContext): Promise<void>;
//# sourceMappingURL=phantom-offline-routes.d.ts.map