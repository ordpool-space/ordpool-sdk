#!/usr/bin/env node
/**
 * Fails when a Chrome net log shows traffic that left the machine.
 *
 *   node scripts/check-net-log.mjs <dir>
 *
 * Reads every `*.json` net log in <dir> (written by `launchWalletContext` when
 * ORDPOOL_E2E_NET_LOG_DIR is set), checks each against the hosts the launch
 * let through (`reachableHosts()`, from the same environment the run used),
 * and prints per file the leaks, the URL requests that failed inside the
 * browser, and the UDP probes (see e2e/playwright/net-log.ts for what each
 * means). Exit 1 on any leak, and on a directory with no net log or no
 * directory at all: a gate that read nothing proves nothing. The directory is
 * created by the first launch that writes a log, so it is missing when the run
 * failed before any browser started.
 *
 * It reads the compiled helpers in dist-e2e/, so it runs wherever the
 * package is installed, in this repo and in a consumer.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { parseNetLog, checkNetLog } = require('../dist-e2e/playwright/net-log.js');
const { reachableHosts } = require('../dist-e2e/playwright/launch-wallet-context.js');

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/check-net-log.mjs <dir>');
  process.exit(2);
}

if (!existsSync(dir)) {
  console.error(`${dir}: no such directory, so no browser wrote a net log. Either the run failed before its first browser launch, or ORDPOOL_E2E_NET_LOG_DIR was not set for it. Nothing was checked.`);
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error(`${dir}: no net log. The launches did not write one (is ORDPOOL_E2E_NET_LOG_DIR set for the run?).`);
  process.exit(1);
}

const hosts = reachableHosts();
console.log(`reachable hosts: ${hosts.join(', ')}`);

/** `['a', 'b', 'a']` -> `['2  a', '1  b']`, most frequent first. */
function tally(lines) {
  const counts = new Map();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].sort((x, y) => y[1] - x[1]).map(([l, n]) => `${String(n).padStart(4)}  ${l}`);
}

let leaks = 0;
const blockedAll = [];
const probesAll = [];
for (const f of files) {
  const report = checkNetLog(parseNetLog(readFileSync(join(dir, f), 'utf8')), hosts);
  console.log(`${f}: ${report.leaks.length} left the machine, ${report.blocked.length} blocked in the browser, ${report.probes.length} UDP probes`);
  for (const l of tally(report.leaks)) console.log(`  LEAK ${l}`);
  leaks += report.leaks.length;
  blockedAll.push(...report.blocked.map((b) => b.replace(/^(\S+ \S+?:\/\/[^/]+).*/, '$1')));
  probesAll.push(...report.probes);
}

console.log(`\nblocked in the browser, by origin (${blockedAll.length}):`);
for (const l of tally(blockedAll)) console.log(l);
console.log(`\nUDP probes, no datagram sent (${probesAll.length}):`);
for (const l of tally(probesAll)) console.log(l);
console.log(`\n${files.length} net logs, ${leaks} requests left the machine.`);
process.exit(leaks === 0 ? 0 : 1);
