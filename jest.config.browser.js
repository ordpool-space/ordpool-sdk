const { createCjsPreset } = require('jest-preset-angular/presets');

/** @type {import('jest').Config} */
module.exports = {
  ...createCjsPreset(),
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.config.browser.setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/e2e/'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  // sats-connect v4+ is ESM-only; let babel-jest transform its
  // .mjs files to CJS for Jest.
  transformIgnorePatterns: [
    // Transform everything in node_modules — many sats-connect
    // transitive deps ship ESM-only.
    'node_modules/.*\\.snap$',
  ],
  // Merge the Angular preset's transforms with babel-jest for .mjs.
  transform: {
    ...createCjsPreset().transform,
    '^.+\\.(js|jsx|mjs|cjs)$': 'babel-jest',
  },
  // Same as the node config — modern ESM packages with only an
  // `import` condition need this for Jest's resolver.
  testEnvironmentOptions: {
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
