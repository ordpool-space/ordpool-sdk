#!/usr/bin/env node
// Bundles e2e/playwright/fixtures/sdk-harness.ts into a single
// browser-loadable ESM file at the same path with a .js extension.
// Run before the Playwright tests (locally and in CI) so the
// fixtures HTTP server can serve a static script with no build
// step at request time.

const esbuild = require('esbuild');
const path = require('node:path');

const fixturesDir = path.resolve(__dirname, 'fixtures');

esbuild.build({
  entryPoints: [path.join(fixturesDir, 'sdk-harness.ts')],
  outfile:     path.join(fixturesDir, 'sdk-harness.js'),
  bundle:      true,
  format:      'esm',
  platform:    'browser',
  target:      'es2022',
  // The SDK source has TS module references with no extensions.
  // esbuild resolves them via tsconfig + nodejs resolution.
  resolveExtensions: ['.ts', '.mjs', '.js'],
  logLevel:    'info',
}).then(() => {
  // eslint-disable-next-line no-console
  console.log('harness bundle built: e2e/playwright/fixtures/sdk-harness.js');
}).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('harness bundle failed:', err);
  process.exit(1);
});
