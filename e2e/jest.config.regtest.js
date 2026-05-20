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

  // Block-mining + electrs-sync needs more than the default 5s.
  testTimeout: 30_000,
  maxWorkers: 1,
  passWithNoTests: false,
};
