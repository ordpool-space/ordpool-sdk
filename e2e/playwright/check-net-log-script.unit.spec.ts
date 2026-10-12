/**
 * @test-kind unit
 * Real:   scripts/check-net-log.mjs, run as CI runs it (node, a directory argument), reading dist-e2e
 * Faked:  nothing; the logs are the captured Chrome net logs in net-log-fixtures/ (see net-log.unit.spec.ts)
 * Proves: the gate exits 1 with its own sentence when the directory is missing or holds no net log, exits 1
 *         on a log whose traffic left the machine, and exits 0 on an offline browser's log
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../scripts/check-net-log.mjs');
const FIXTURES = path.resolve(__dirname, 'net-log-fixtures');

/** Runs the gate on `dir` with the loopback-only host set a launch would see. */
function gate(dir: string): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('REGTEST_') || k.startsWith('E2E_')) delete env[k];
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A fresh directory holding the named fixtures. */
function dirWith(...fixtures: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-log-gate-'));
  for (const f of fixtures) fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
  return dir;
}

describe('scripts/check-net-log.mjs', () => {
  it('a missing directory fails and says no browser wrote a log', () => {
    const dir = path.join(os.tmpdir(), `net-log-gate-missing-${process.pid}`);
    const r = gate(dir);
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe(
      `${dir}: no such directory, so no browser wrote a net log. Either the run failed before its first browser launch, or ORDPOOL_E2E_NET_LOG_DIR was not set for it. Nothing was checked.`,
    );
  });

  it('an empty directory fails and says there is no net log', () => {
    const dir = dirWith();
    const r = gate(dir);
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe(`${dir}: no net log. The launches did not write one (is ORDPOOL_E2E_NET_LOG_DIR set for the run?).`);
  });

  it('a log with traffic that left the machine fails', () => {
    const r = gate(dirWith('chromium-148-online.json'));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^1 net logs, [1-9]\d* requests left the machine\.$/m);
  });

  it('an offline browser log passes', () => {
    const r = gate(dirWith('chromium-148-offline.json'));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^1 net logs, 0 requests left the machine\.$/m);
  });
});
