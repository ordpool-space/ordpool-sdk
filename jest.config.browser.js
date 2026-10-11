/**
 * The per-wait bound of the e2e helpers whose unit specs run here on fake
 * timers, read through ORDPOOL_E2E_TIMEOUT_MS: the same value the e2e runner
 * configs set, so the specs prove the bound the helpers run under.
 */
const WAIT_TIMEOUT_MS = 30_000;
process.env.ORDPOOL_E2E_TIMEOUT_MS = String(WAIT_TIMEOUT_MS);

/**
 * The per-test bound, for every test and hook.
 * Twice the longest green spec file, rounded up: 26.4 s, src/cat21-fee/vsize-max-signatures in ordpool-sdk run 38074082493.
 */
const TEST_TIMEOUT_MS = 60_000;

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  // jsdom for specs that touch browser globals (wallet signers reading
  // `window.<wallet>`, WebCrypto, DecompressionStream, TextEncoder).
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.config.browser.setup.ts'],
  // RESCUE/ holds code rescued from cat21-wallet pending port to the SDK
  // proper — see jest.config.node.js for the full rationale. `.node.spec.ts`
  // is the node-only counterpart: a spec that needs a runtime global jsdom
  // doesn't implement (e.g. `CompressionStream` / `DecompressionStream` for
  // native gzip) and so must run under node.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/e2e/', '/RESCUE/', '\\.node\\.spec\\.ts$', '/check-test-kinds\\.selftest/'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  // Transform every node_modules file except snapshots — sats-connect
  // v4 ships ESM-only. Same rationale as jest.config.node.js.
  transformIgnorePatterns: ['node_modules/.*\\.snap$'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.(js|jsx|mjs|cjs)$': 'babel-jest',
  },
  testEnvironmentOptions: {
    // See jest.config.node.js for why `import` is omitted.
    customExportConditions: ['browser', 'require', 'default'],
  },
    // Source imports carry explicit `.js` extensions so the ESM build is
  // resolvable by Node. Jest compiles the .ts sources, so strip the
  // extension back off. (ESM-extension mapping)
  moduleNameMapper: {
    '^(\.{1,2}/.*)\.js$': '$1',
    '^base58-js$': '<rootDir>/node_modules/base58-js/index.js',
  },

  // avoids "Do not know how to serialize a BigInt" instead of showing the actual assertion error message
  // see https://github.com/jestjs/jest/issues/11617#issuecomment-1028651059
  maxWorkers: 1,

  // A run matching zero tests is a broken filter, not a pass.
  passWithNoTests: false,

  testTimeout: TEST_TIMEOUT_MS,
};
