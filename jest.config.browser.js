const { createCjsPreset } = require('jest-preset-angular/presets');

/** @type {import('jest').Config} */
module.exports = {
  ...createCjsPreset(),
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.config.browser.setup.ts'],
  // RESCUE/ holds code rescued from cat21-wallet pending port to
  // the SDK proper — see jest.config.node.js for the full rationale.
  // `.node.spec.ts` is the node-only counterpart to the node config's
  // browser-only `.angular.spec.ts` skip: a spec whose module graph
  // needs the `node` export condition (e.g. brotli-wasm's node wasm
  // variant) and can't resolve the `browser` variant under jsdom.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/e2e/', '/RESCUE/', '\\.node\\.spec\\.ts$'],
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
    // brotli-wasm's `browser` export condition resolves the webpack
    // syncWebAssembly variant, which jsdom can't instantiate. Map it to
    // the node wasm variant (identical wasm bytes, jest-loadable) so the
    // browser-env spec exercises real brotli compression under jsdom.
    '^brotli-wasm$': '<rootDir>/node_modules/brotli-wasm/index.node.js',
  },

  // avoids "Do not know how to serialize a BigInt" instead of showing the actual assertion error message
  // see https://github.com/jestjs/jest/issues/11617#issuecomment-1028651059
  maxWorkers: 1,

  // SDK is empty for now -- no specs yet. Don't fail CI on "no tests found".
  passWithNoTests: true,
};
