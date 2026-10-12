import { type Browser, type BrowserContext, type BrowserType } from '@playwright/test';
/**
 * The loopback names every launch lets through: the SDK harness page
 * (`fixtures-server.js` on localhost), a consumer's served app, and the
 * regtest stack's published ports all answer here.
 */
export declare const LOOPBACK_HOSTS: readonly string[];
/**
 * The proxy every non-local request is sent to: TCP port 9 (RFC 863 discard)
 * on loopback. It is a privileged port nothing listens on, so the connect is
 * refused at once and the request fails with `ERR_PROXY_CONNECTION_FAILED`.
 * `launchWalletContext` checks the refusal before every launch.
 */
export declare const DEAD_PROXY_HOST = "127.0.0.1";
export declare const DEAD_PROXY_PORT = 9;
/**
 * When set, every launch writes Chrome's net log (`--log-net-log`) into this
 * directory, one JSON file per context. `scripts/check-net-log.mjs` reads the
 * directory and fails when anything left the machine.
 */
export declare const NET_LOG_DIR_ENV = "ORDPOOL_E2E_NET_LOG_DIR";
/** The wallets the SDK harness launches. */
export type LaunchableWallet = 'xverse' | 'unisat' | 'leather' | 'okx' | 'phantom' | 'wizz' | 'alby' | 'cat21wallet';
/**
 * The hosts a test browser may reach: loopback, plus the host of every regtest
 * service URL in `env` (`regtestServiceUrls`: electrs, cat21-ord, stock ord,
 * the ordpool backend, the fees stub, the harness, the consumer app and its backend)
 * and of `XVERSE_REGTEST_ELECTRS_URL`, plus `extraHosts` (a consumer's own
 * server). Derived from the same environment the stack and its helpers read,
 * so pointing a service elsewhere moves the exception with it. No production
 * host is ever on this list.
 */
export declare function reachableHosts(env?: NodeJS.ProcessEnv, extraHosts?: readonly string[]): string[];
/**
 * The Chromium switches that keep a browser off the network except for
 * `hosts`.
 *
 * - `--host-resolver-rules`: every host, IP literals included, resolves to
 *   nothing (`~NOTFOUND`) except `hosts`. This stops lookups that never reach
 *   a proxy, such as a WebRTC STUN server named by host. The rules spell an
 *   IPv6 literal bare (`::1`); bracketed, it does not match.
 * - `--proxy-server` + `--proxy-bypass-list`: every request to anything but
 *   `hosts` goes to the dead proxy and fails at once, before any lookup.
 *   This covers what the resolver rules alone leave open: Chromium's DNS
 *   probe after a failed navigation, which queries `google.com` through its
 *   own resolver and a public DNS server. The bypass list spells IPv6
 *   bracketed (`[::1]`).
 */
export declare function offlineLaunchArgs(hosts: readonly string[]): string[];
export interface LaunchWalletContextOptions {
    /** The unpacked extension directory. */
    extensionPath: string;
    /** Which wallet `extensionPath` holds: adds its launch switches and names its net log. */
    wallet?: LaunchableWallet;
    /** A persistent profile directory; `''` (the default) is a fresh temporary profile. */
    userDataDir?: string;
    /** Extensions load only headed; default `false`. */
    headless?: boolean;
    /** Hosts beyond `reachableHosts()` the browser must reach, such as a consumer's app server. */
    extraHosts?: readonly string[];
    /** Further Chromium switches. */
    args?: readonly string[];
}
/**
 * The switches every test browser gets, with or without an extension: no
 * sandbox and no `/dev/shm` (CI containers), offline except for
 * `reachableHosts(env, extraHosts)`, then `args`.
 */
export declare function offlineBrowserArgs(opts?: {
    extraHosts?: readonly string[];
    args?: readonly string[];
}, env?: NodeJS.ProcessEnv): string[];
/** The switches `launchWalletContext` passes, without the net log. */
export declare function walletLaunchArgs(opts: LaunchWalletContextOptions, env?: NodeJS.ProcessEnv): string[];
/** `--log-net-log=<dir>/<wallet>-<pid>-<n>.json` when `NET_LOG_DIR_ENV` is set, else nothing. */
export declare function netLogArgs(wallet: string | undefined, env?: NodeJS.ProcessEnv): string[];
/** Resolves when nothing accepts a connection on host:port, throws when something does. */
export declare function assertPortRefuses(host: string, port: number): Promise<void>;
/**
 * Launch Chromium with one wallet extension loaded and no way to the
 * network but the regtest stack and loopback (`reachableHosts`).
 *
 * Every request elsewhere, from a page, the extension's service worker or
 * Chromium itself, fails at once (`ERR_NAME_NOT_RESOLVED` or
 * `ERR_PROXY_CONNECTION_FAILED`), from the first instant of the context, so a
 * test never depends on a vendor's host being up, slow or changed. The vendor
 * shields (`installOkxOfflineRoutes` and its siblings) still answer the
 * requests a flow needs; install them right after this resolves.
 */
export declare function launchWalletContext(opts: LaunchWalletContextOptions): Promise<BrowserContext>;
/** `launchPersistentContext`'s options, less the two every offline launch sets itself. */
export type OfflineContextOptions = Omit<NonNullable<Parameters<BrowserType['launchPersistentContext']>[1]>, 'args' | 'headless'>;
/** `launch`'s options, less the two every offline launch sets itself. */
export type OfflineBrowserOptions = Omit<NonNullable<Parameters<BrowserType['launch']>[0]>, 'args' | 'headless'>;
/** What a test browser without an extension takes. */
export interface LaunchOfflineOptions {
    /** Names the net log file (`<name>-<pid>-<n>.json`); default `context`. */
    name?: string;
    /** Default `true`: a browser without an extension needs no window. */
    headless?: boolean;
    /** Hosts beyond `reachableHosts()` the browser must reach, such as a consumer's app server. */
    extraHosts?: readonly string[];
    /** Further Chromium switches. */
    args?: readonly string[];
}
/** The switches `launchOfflineBrowser` and `launchOfflineContext` pass, net log included. */
export declare function offlineLaunchSwitches(opts?: LaunchOfflineOptions, env?: NodeJS.ProcessEnv): string[];
/**
 * Launch Chromium without an extension, under the guarantees of
 * `launchWalletContext`: the dead proxy is checked first, nothing but
 * `reachableHosts()` and `extraHosts` resolves or connects, and with
 * `ORDPOOL_E2E_NET_LOG_DIR` set one net log records the whole browser, every
 * context it opens included. For a watch-only (xpub) account or a page that
 * needs no wallet; each test opens its own `browser.newContext()`.
 */
export declare function launchOfflineBrowser(opts?: LaunchOfflineOptions & {
    options?: OfflineBrowserOptions;
}): Promise<Browser>;
/**
 * `launchOfflineBrowser` as one persistent context, for a spec that keeps a
 * single context across its tests. `userDataDir` `''` (the default) is a fresh
 * temporary profile; `options` carries context settings such as `viewport`.
 */
export declare function launchOfflineContext(opts?: LaunchOfflineOptions & {
    userDataDir?: string;
    options?: OfflineContextOptions;
}): Promise<BrowserContext>;
//# sourceMappingURL=launch-wallet-context.d.ts.map