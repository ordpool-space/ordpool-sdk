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
exports.NET_LOG_DIR_ENV = exports.DEAD_PROXY_PORT = exports.DEAD_PROXY_HOST = exports.LOOPBACK_HOSTS = void 0;
exports.reachableHosts = reachableHosts;
exports.offlineLaunchArgs = offlineLaunchArgs;
exports.walletLaunchArgs = walletLaunchArgs;
exports.netLogArgs = netLogArgs;
exports.assertPortRefuses = assertPortRefuses;
exports.launchWalletContext = launchWalletContext;
const test_1 = require("@playwright/test");
const fs = __importStar(require("node:fs"));
const net = __importStar(require("node:net"));
const path = __importStar(require("node:path"));
const regtest_helpers_1 = require("../regtest/regtest-helpers");
/**
 * The loopback names every launch lets through: the SDK harness page
 * (`fixtures-server.js` on localhost), a consumer's served app, and the
 * regtest stack's published ports all answer here.
 */
exports.LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
/**
 * The proxy every non-local request is sent to: TCP port 9 (RFC 863 discard)
 * on loopback. It is a privileged port nothing listens on, so the connect is
 * refused at once and the request fails with `ERR_PROXY_CONNECTION_FAILED`.
 * `launchWalletContext` checks the refusal before every launch.
 */
exports.DEAD_PROXY_HOST = '127.0.0.1';
exports.DEAD_PROXY_PORT = 9;
/**
 * When set, every launch writes Chrome's net log (`--log-net-log`) into this
 * directory, one JSON file per context. `scripts/check-net-log.mjs` reads the
 * directory and fails when anything left the machine.
 */
exports.NET_LOG_DIR_ENV = 'ORDPOOL_E2E_NET_LOG_DIR';
/**
 * Switches a wallet needs at launch, beyond loading it.
 *
 * - okx: `navigator.webdriver` hidden; with it visible OKX absorbs the click on
 *   its welcome screen (`onboardOkx`).
 */
const WALLET_ARGS = {
    okx: ['--disable-blink-features=AutomationControlled'],
};
/** The host part of a URL (`URL.hostname`: IPv6 bracketed). */
function hostOf(url) {
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
function reachableHosts(env = process.env, extraHosts = []) {
    const services = (0, regtest_helpers_1.regtestServiceUrls)(env);
    const urls = [services.electrs, services.ord, services.ordStock];
    if (env.XVERSE_REGTEST_ELECTRS_URL)
        urls.push(env.XVERSE_REGTEST_ELECTRS_URL);
    return [...new Set([...exports.LOOPBACK_HOSTS, ...urls.map(hostOf), ...extraHosts])];
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
function offlineLaunchArgs(hosts) {
    const exclude = hosts.map((h) => `EXCLUDE ${h.replace(/^\[(.*)\]$/, '$1')}`).join(', ');
    return [
        `--host-resolver-rules=MAP * ~NOTFOUND, ${exclude}`,
        `--proxy-server=http://${exports.DEAD_PROXY_HOST}:${exports.DEAD_PROXY_PORT}`,
        `--proxy-bypass-list=${hosts.join(';')}`,
    ];
}
/** The switches `launchWalletContext` passes, without the net log. */
function walletLaunchArgs(opts, env = process.env) {
    return [
        `--disable-extensions-except=${opts.extensionPath}`,
        `--load-extension=${opts.extensionPath}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        ...offlineLaunchArgs(reachableHosts(env, opts.extraHosts)),
        ...(opts.wallet ? WALLET_ARGS[opts.wallet] ?? [] : []),
        ...(opts.args ?? []),
    ];
}
let netLogSeq = 0;
/** `--log-net-log=<dir>/<wallet>-<pid>-<n>.json` when `NET_LOG_DIR_ENV` is set, else nothing. */
function netLogArgs(wallet, env = process.env) {
    const dir = env[exports.NET_LOG_DIR_ENV];
    if (!dir)
        return [];
    fs.mkdirSync(dir, { recursive: true });
    netLogSeq += 1;
    return [`--log-net-log=${path.resolve(dir, `${wallet ?? 'context'}-${process.pid}-${netLogSeq}.json`)}`];
}
/** Resolves when nothing accepts a connection on host:port, throws when something does. */
function assertPortRefuses(host, port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, host);
        socket.once('connect', () => {
            socket.destroy();
            reject(new Error(`${host}:${port} accepts connections, so it cannot serve as the dead proxy that keeps the browser offline. ` +
                'Stop whatever listens there.'));
        });
        socket.once('error', (err) => {
            if (err.code === 'ECONNREFUSED')
                resolve();
            else
                reject(err);
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
async function launchWalletContext(opts) {
    await assertPortRefuses(exports.DEAD_PROXY_HOST, exports.DEAD_PROXY_PORT);
    return test_1.chromium.launchPersistentContext(opts.userDataDir ?? '', {
        headless: opts.headless ?? false,
        args: [...walletLaunchArgs(opts), ...netLogArgs(opts.wallet)],
    });
}
//# sourceMappingURL=launch-wallet-context.js.map