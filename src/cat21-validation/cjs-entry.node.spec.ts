import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The server-facing subpaths must be require-able from CommonJS.
 *
 * Node itself can `require()` ESM on the versions we run, but a jest CJS
 * runtime with `node_modules` untransformed cannot, and that is where a
 * NestJS backend's unit tests live. So these three carry a `require`
 * condition pointing at a CommonJS emit, and this proves the emit loads
 * rather than merely existing.
 *
 * Run in a child process: this suite is itself ESM-ish under ts-jest, and the
 * thing under test is what a plain `node -e "require(...)"` sees.
 */
const ROOT = path.resolve(__dirname, '../..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SUBPATHS = ['./cat21-validation', './cat21-session', './network'];
const built = SUBPATHS.every((s) => fs.existsSync(path.join(ROOT, PKG.exports[s].require)));

describe('server-facing subpaths ship a CommonJS build', () => {
  it.each(SUBPATHS)('%s declares a require condition pointing at dist-cjs', (sub) => {
    expect(PKG.exports[sub].require).toMatch(/^\.\/dist-cjs\//);
  });

  (built ? it : it.skip)('the CommonJS emit actually loads and carries the symbols', () => {
    const file = path.join(ROOT, PKG.exports['./cat21-validation'].require);
    const out = execFileSync(
      process.execPath,
      ['-e', `const m=require(${JSON.stringify(file)});
        process.stdout.write([typeof m.validateCat21BuyOfferPsbt, typeof m.verifyBip322Signature, typeof m.MAX_ASK_SATS].join(','))`],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(out).toBe('function,function,number');
  });
});
