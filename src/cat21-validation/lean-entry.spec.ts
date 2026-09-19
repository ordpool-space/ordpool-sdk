import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The server-facing subpath must stay free of the wallet-connector graph.
 *
 * `sats-connect` is a PEER dependency, so a backend with no wallet UI does not
 * install it. Importing the broad `/core` barrel for one validator therefore
 * fails at require time with a message that names sats-connect rather than the
 * mistake. This walks the BUILT graph, because the hazard is what the emitted
 * files import, not what the source appears to.
 */
function graphOf(entry: string): { files: number; bare: string[] } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const stack = [path.resolve(entry)];
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f) || !fs.existsSync(f)) continue;
    seen.add(f);
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        const p = path.normalize(path.join(path.dirname(f), spec));
        stack.push(p.endsWith('.js') ? p : `${p}.js`);
      } else {
        bare.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
      }
    }
  }
  return { files: seen.size, bare: [...bare].sort() };
}

const DIST = path.resolve(__dirname, '../../dist');
const built = fs.existsSync(path.join(DIST, 'cat21-validation/index.js'));

(built ? describe : describe.skip)('the server-facing subpaths carry no wallet graph', () => {
  it.each(['cat21-validation/index.js', 'cat21-session/index.js'])(
    '%s resolves without sats-connect',
    (entry) => {
      const { bare } = graphOf(path.join(DIST, entry));
      // Every remaining bare import must be a real dependency a server installs,
      // never a peer it has no reason to have.
      expect(bare.filter((d) => d === 'sats-connect')).toEqual([]);
    },
  );

  it('cat21-validation exposes what a seller backend needs', async () => {
    const m = await import(path.join(DIST, 'cat21-validation/index.js'));
    expect({
      validator: typeof m.validateCat21BuyOfferPsbt,
      bip322: typeof m.verifyBip322Signature,
      ceiling: typeof m.MAX_ASK_SATS,
    }).toEqual({ validator: 'function', bip322: 'function', ceiling: 'number' });
  });
});
