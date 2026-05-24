// Regtest E2E test config. Runs Jest in Node, expects a regtest
// bitcoind + electrs already up via `e2e/regtest-bootstrap.sh`.
//
// REGTEST_FUNDED_ADDR + REGTEST_FUNDED_WIF env vars need to be set
// (the bootstrap script emits them as JSON).

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
  moduleNameMapper: {
    '^base58-js$': '<rootDir>/node_modules/base58-js/index.js',
  },

  // Block-mining + electrs-sync needs more than the default 5s.
  testTimeout: 30_000,
  maxWorkers: 1,
  passWithNoTests: false,
};
