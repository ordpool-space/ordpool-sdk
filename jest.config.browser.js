const { createCjsPreset } = require('jest-preset-angular/presets');

/** @type {import('jest').Config} */
module.exports = {
  ...createCjsPreset(),
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.config.browser.setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/e2e/'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  // Transform every node_modules file except snapshots — sats-connect
  // v4 ships ESM-only. Same rationale as jest.config.node.js.
  transformIgnorePatterns: ['node_modules/.*\\.snap$'],
  transform: {
    ...createCjsPreset().transform,
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

  // SDK is empty for now -- no specs yet. Don't fail CI on "no tests found".
  passWithNoTests: true,
};
