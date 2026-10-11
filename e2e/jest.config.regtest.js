// Regtest E2E test config. Runs Jest in Node, expects a regtest
// bitcoind + electrs already up via `e2e/regtest-bootstrap.sh`.
//
// REGTEST_FUNDED_ADDR + REGTEST_FUNDED_WIF env vars need to be set
// (the bootstrap script emits them as JSON).

/**
 * The per-wait bound (TESTING.md): through ORDPOOL_E2E_TIMEOUT_MS, every poll
 * the SDK's regtest helpers run against bitcoind, electrs and ord. A state that
 * needs longer to arrive is a defect in the stack or the helper, fixed there,
 * never by raising this bound.
 */
const WAIT_TIMEOUT_MS = 30_000;
process.env.ORDPOOL_E2E_TIMEOUT_MS = String(WAIT_TIMEOUT_MS);

/**
 * The per-test bound, for every test and hook: a sequence of waits, not one wait.
 * Twice the longest green spec file: 161 s, inscribe-satpoint-parity in ordpool-sdk run 38074082476.
 */
const TEST_TIMEOUT_MS = 330_000;

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '..',
  testMatch: ['<rootDir>/e2e/regtest/**/*.spec.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],

  // Same sats-connect-v4 ESM workaround as jest.config.node.js. The
  // regtest specs transitively import from src/network.ts, which
  // imports sats-connect (ESM-only). Without babel-jest transforming
  // node_modules, Jest's CJS loader hits SyntaxError on the `import`.
  transformIgnorePatterns: ['node_modules/.*\\.snap$'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.(js|jsx|mjs|cjs)$': 'babel-jest',
  },
  testEnvironmentOptions: {
    // See jest.config.node.js for why `import` is omitted.
    customExportConditions: ['node', 'require', 'default'],
  },
    // Source imports carry explicit `.js` extensions so the ESM build is
  // resolvable by Node. Jest compiles the .ts sources, so strip the
  // extension back off. (ESM-extension mapping)
  moduleNameMapper: {
    '^(\.{1,2}/.*)\.js$': '$1',
    '^base58-js$': '<rootDir>/node_modules/base58-js/index.js',
  },

  testTimeout: TEST_TIMEOUT_MS,
  maxWorkers: 1,
  passWithNoTests: false,
};
