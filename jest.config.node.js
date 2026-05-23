/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  // this test runs in a normal node environment
  testEnvironment: 'node',

  // Angular-DI specs (anything that imports @angular/core directly)
  // live in *.angular.spec.ts and run only under the browser config,
  // where jest-preset-angular handles the @angular/* ESM transforms.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/e2e/', '\\.angular\\.spec\\.ts$'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  // sats-connect v4+ ships ESM-only; whitelist it (and its core
  // sub-deps) for the transform stage. Without this Jest hits
  // SyntaxError on the `import` statement in node_modules.
  transformIgnorePatterns: [
    // Match nothing — many sats-connect transitive deps ship ESM-
    // only (synckit, bitcoin-address-validation, base58-js, etc.).
    // Transform everything; ts-jest + babel-jest's caches keep
    // this affordable.
    'node_modules/.*\\.snap$',
  ],
  // ts-jest handles .ts/.tsx; babel-jest handles the .mjs files
  // sats-connect ships under node_modules (via babel.config.cjs).
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.(js|jsx|mjs|cjs)$': 'babel-jest',
  },
  // Several sats-connect transitive deps (base58-js etc.) ship
  // exports maps with only an `import` condition; others (synckit
  // etc.) have both `import` and `require`. Order matters here:
  // prefer the CJS `require` form when available — Jest's CJS
  // loader can execute it directly. Fall back to `import` for
  // ESM-only packages (babel-jest will transform).
  testEnvironmentOptions: {
    // No `import` here — packages whose exports map has BOTH
    // `import` and `require` branches (synckit etc.) match the
    // FIRST condition key listed in their map, not the order
    // we list here, so adding `import` makes Jest resolve the
    // ESM file and bomb. Use Jest's CJS-style resolution and
    // let babel-jest handle the import-only-exports packages
    // (base58-js etc.) via moduleNameMapper.
    customExportConditions: ['node', 'require', 'default'],
  },
  moduleNameMapper: {
    // Packages with `exports` maps that only declare an `import`
    // condition (no `require`) — Jest's resolver bails. Map them
    // by name to their actual .js file.
    '^base58-js$': '<rootDir>/node_modules/base58-js/index.js',
  },

  // avoids "Do not know how to serialize a BigInt" instead of showing the actual assertion error message
  // see https://github.com/jestjs/jest/issues/11617#issuecomment-1028651059
  maxWorkers: 1,

  // SDK is empty for now -- no specs yet. Don't fail CI on "no tests found".
  passWithNoTests: true,
};
