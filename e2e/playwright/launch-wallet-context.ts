import { chromium, type Browser, type BrowserContext, type BrowserType } from '@playwright/test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import { regtestServiceUrls } from '../regtest/regtest-helpers';

/**
 * The loopback names every launch lets through: the SDK harness page
 * (`fixtures-server.js` on localhost), a consumer's served app, and the
 * regtest stack's published ports all answer here.
 */
export const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The proxy every non-local request is sent to: TCP port 9 (RFC 863 discard)
 * on loopback. It is a privileged port nothing listens on, so the connect is
 * refused at once and the request fails with `ERR_PROXY_CONNECTION_FAILED`.
 * `launchWalletContext` checks the refusal before every launch.
 */
export const DEAD_PROXY_HOST = '127.0.0.1';
export const DEAD_PROXY_PORT = 9;

/**
 * When set, every launch writes Chrome's net log (`--log-net-log`) into this
 * directory, one JSON file per context. `scripts/check-net-log.mjs` reads the
 * directory and fails when anything left the machine.
 */
export const NET_LOG_DIR_ENV = 'ORDPOOL_E2E_NET_LOG_DIR';

/** The wallets the SDK harness launches. */
export type LaunchableWallet = 'xverse' | 'unisat' | 'leather' | 'okx' | 'phantom' | 'wizz' | 'alby' | 'cat21wallet';

/**
 * Switches a wallet needs at launch, beyond loading it.
 *
 * - okx: `navigator.webdriver` hidden; with it visible OKX absorbs the click on
 *   its welcome screen (`onboardOkx`).
 */
const WALLET_ARGS: Partial<Record<LaunchableWallet, readonly string[]>> = {
  okx: ['--disable-blink-features=AutomationControlled'],
};

/** The host part of a URL (`URL.hostname`: IPv6 bracketed). */
function hostOf(url: string): string {
  return new URL(url).hostname;
}

/**
 * The hosts a test browser may reach: loopback, plus the host of every regtest
 * service URL in `env` (`regtestServiceUrls`: electrs, cat21-ord, stock ord)
 * and of `XVERSE_REGTEST_ELECTRS_URL`, plus `extraHosts` (a consumer's own
 * server). Derived from the same environment the stack and its helpers read,
 * so pointing a service elsewhere moves the exception with it. No production
 * host is ever on this list.
 */
export function reachableHosts(env: NodeJS.ProcessEnv = process.env, extraHosts: readonly string[] = []): string[] {
  const services = regtestServiceUrls(env);
  const urls = [services.electrs, services.ord, services.ordStock];
  if (env.XVERSE_REGTEST_ELECTRS_URL) urls.push(env.XVERSE_REGTEST_ELECTRS_URL);
  return [...new Set([...LOOPBACK_HOSTS, ...urls.map(hostOf), ...extraHosts])];
}

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
export function offlineLaunchArgs(hosts: readonly string[]): string[] {
  const exclude = hosts.map((h) => `EXCLUDE ${h.replace(/^\[(.*)\]$/, '$1')}`).join(', ');
  return [
    `--host-resolver-rules=MAP * ~NOTFOUND, ${exclude}`,
    `--proxy-server=http://${DEAD_PROXY_HOST}:${DEAD_PROXY_PORT}`,
    `--proxy-bypass-list=${hosts.join(';')}`,
  ];
}

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
export function offlineBrowserArgs(
  opts: { extraHosts?: readonly string[]; args?: readonly string[] } = {},
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...offlineLaunchArgs(reachableHosts(env, opts.extraHosts)),
    ...(opts.args ?? []),
  ];
}

/** The switches `launchWalletContext` passes, without the net log. */
export function walletLaunchArgs(opts: LaunchWalletContextOptions, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    `--disable-extensions-except=${opts.extensionPath}`,
    `--load-extension=${opts.extensionPath}`,
    ...offlineBrowserArgs({
      extraHosts: opts.extraHosts,
      args: [...(opts.wallet ? WALLET_ARGS[opts.wallet] ?? [] : []), ...(opts.args ?? [])],
    }, env),
  ];
}

let netLogSeq = 0;

/** `--log-net-log=<dir>/<wallet>-<pid>-<n>.json` when `NET_LOG_DIR_ENV` is set, else nothing. */
export function netLogArgs(wallet: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = env[NET_LOG_DIR_ENV];
  if (!dir) return [];
  fs.mkdirSync(dir, { recursive: true });
  netLogSeq += 1;
  return [`--log-net-log=${path.resolve(dir, `${wallet ?? 'context'}-${process.pid}-${netLogSeq}.json`)}`];
}

/** Resolves when nothing accepts a connection on host:port, throws when something does. */
export function assertPortRefuses(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(
        `${host}:${port} accepts connections, so it cannot serve as the dead proxy that keeps the browser offline. ` +
        'Stop whatever listens there.',
      ));
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') resolve();
      else reject(err);
    });
  });
}

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
export async function launchWalletContext(opts: LaunchWalletContextOptions): Promise<BrowserContext> {
  return launchPersistentOffline(opts.userDataDir ?? '', {
    headless: opts.headless ?? false,
    args: [...walletLaunchArgs(opts), ...netLogArgs(opts.wallet)],
  });
}

/** `launchPersistentContext`'s options, less the two every offline launch sets itself. */
export type OfflineContextOptions = Omit<NonNullable<Parameters<BrowserType['launchPersistentContext']>[1]>, 'args' | 'headless'>;

/** `launch`'s options, less the two every offline launch sets itself. */
export type OfflineBrowserOptions = Omit<NonNullable<Parameters<BrowserType['launch']>[0]>, 'args' | 'headless'>;

/** The one persistent launch behind `launchWalletContext` and `launchOfflineContext`: dead proxy checked first. */
async function launchPersistentOffline(
  userDataDir: string,
  options: OfflineContextOptions & { headless: boolean; args: string[] },
): Promise<BrowserContext> {
  await assertPortRefuses(DEAD_PROXY_HOST, DEAD_PROXY_PORT);
  return chromium.launchPersistentContext(userDataDir, options);
}

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
export function offlineLaunchSwitches(opts: LaunchOfflineOptions = {}, env: NodeJS.ProcessEnv = process.env): string[] {
  return [...offlineBrowserArgs(opts, env), ...netLogArgs(opts.name, env)];
}

/**
 * Launch Chromium without an extension, under the guarantees of
 * `launchWalletContext`: the dead proxy is checked first, nothing but
 * `reachableHosts()` and `extraHosts` resolves or connects, and with
 * `ORDPOOL_E2E_NET_LOG_DIR` set one net log records the whole browser, every
 * context it opens included. For a watch-only (xpub) account or a page that
 * needs no wallet; each test opens its own `browser.newContext()`.
 */
export async function launchOfflineBrowser(
  opts: LaunchOfflineOptions & { options?: OfflineBrowserOptions } = {},
): Promise<Browser> {
  await assertPortRefuses(DEAD_PROXY_HOST, DEAD_PROXY_PORT);
  return chromium.launch({ ...opts.options, headless: opts.headless ?? true, args: offlineLaunchSwitches(opts) });
}

/**
 * `launchOfflineBrowser` as one persistent context, for a spec that keeps a
 * single context across its tests. `userDataDir` `''` (the default) is a fresh
 * temporary profile; `options` carries context settings such as `viewport`.
 */
export async function launchOfflineContext(
  opts: LaunchOfflineOptions & { userDataDir?: string; options?: OfflineContextOptions } = {},
): Promise<BrowserContext> {
  return launchPersistentOffline(opts.userDataDir ?? '', {
    ...opts.options,
    headless: opts.headless ?? true,
    args: offlineLaunchSwitches(opts),
  });
}
