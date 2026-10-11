/**
 * @test-kind unit
 * Real:   e2e/build-pins.env, e2e/build-pins.sh (check_build_pin, run by bash), e2e/regtest-bootstrap.sh's text,
 *         git
 * Faked:  nothing; the checkouts are throwaway git repositories made in a temp directory
 * Proves: every pin is a full sha, the regtest bootstrap compares the electrs, cat21-ord and ordpool checkouts
 *         with their pins, and a checkout at another revision fails under CI and only reports locally
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PINS_FILE = path.join(__dirname, 'build-pins.env');
const PINS_SH = path.join(__dirname, 'build-pins.sh');

function pins(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(PINS_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** A git repository with one commit; returns its directory and HEAD. */
function checkout(): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x');
  return { dir, head: git('rev-parse', 'HEAD') };
}

/** Source build-pins.sh and run check_build_pin; the exit code and stderr. */
function checkBuildPin(dir: string, pinned: string, ci: boolean): { status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (ci) env.CI = 'true';
  const r = spawnSync('bash', ['-c', `. "${PINS_SH}"; check_build_pin ordpool "$1" "$2"`, 'check', dir, pinned], { env, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

describe('build-pins.env', () => {
  it('pins electrs, cat21-ord, Cat21 Wallet and the ordpool backend, each by a full sha', () => {
    const p = pins();
    expect(Object.keys(p).sort()).toEqual(['CAT21_ORD_SHA', 'CAT21_WALLET_SHA', 'ORDPOOL_ELECTRS_SHA', 'ORDPOOL_SHA']);
    for (const [key, sha] of Object.entries(p)) expect(`${key}=${sha}`).toMatch(/^[A-Z0-9_]+=[0-9a-f]{40}$/);
  });

  it('regtest-bootstrap.sh compares the electrs, cat21-ord and ordpool checkouts with their pins', () => {
    const bootstrap = fs.readFileSync(path.join(__dirname, 'regtest-bootstrap.sh'), 'utf8');
    const checked = [...bootstrap.matchAll(/^check_build_pin \S+ "\$\{([A-Z0-9_]+):-.*\}" "\$([A-Z0-9_]+)"$/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(checked).toEqual(['ELECTRS_SRC ORDPOOL_ELECTRS_SHA', 'CAT21_ORD_SRC CAT21_ORD_SHA', 'ORDPOOL_SRC ORDPOOL_SHA']);
  });
});

describe('check_build_pin', () => {
  it('passes a checkout at its pin, in CI too', () => {
    const c = checkout();
    expect(checkBuildPin(c.dir, c.head, true)).toEqual({ status: 0, stderr: '' });
  });

  it('fails a checkout at another revision under CI, naming both', () => {
    const c = checkout();
    const other = 'f'.repeat(40);
    const r = checkBuildPin(c.dir, other, true);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`build-pins: ordpool at ${c.dir} is at ${c.head}`);
    expect(r.stderr).toContain(`pins ${other}`);
  });

  it('only reports a checkout at another revision outside CI', () => {
    const c = checkout();
    const r = checkBuildPin(c.dir, 'f'.repeat(40), false);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('build-pins: ordpool at');
  });

  it('skips a directory that does not exist: that stack does not build it', () => {
    expect(checkBuildPin(path.join(os.tmpdir(), 'no-such-checkout-'.concat(String(process.pid))), 'f'.repeat(40), true))
      .toEqual({ status: 0, stderr: '' });
  });
});
