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
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/e2e/', '/RESCUE/', '\\.node\\.spec\\.ts$'],
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
  moduleNameMapper: {
    '^base58-js$': '<rootDir>/node_modules/base58-js/index.js',
  },

  // avoids "Do not know how to serialize a BigInt" instead of showing the actual assertion error message
  // see https://github.com/jestjs/jest/issues/11617#issuecomment-1028651059
  maxWorkers: 1,

  // Don't fail CI on "no tests found" for a filtered run.
  passWithNoTests: true,
};
