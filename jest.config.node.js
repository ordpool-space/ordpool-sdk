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
  // Transform every node_modules file except snapshots — sats-connect
  // v4 and several of its transitive deps (synckit, base58-js,
  // bitcoin-address-validation, valibot) ship ESM-only.
  transformIgnorePatterns: ['node_modules/.*\\.snap$'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.(js|jsx|mjs|cjs)$': 'babel-jest',
  },
  testEnvironmentOptions: {
    // `import` is deliberately omitted: packages whose exports map
    // has BOTH `import` and `require` branches (synckit etc.)
    // resolve to the FIRST key declared in their map, not the
    // order listed here, so adding `import` makes Jest pick the
    // ESM file and bomb. Let babel-jest handle import-only
    // packages (base58-js etc.) via moduleNameMapper below.
    customExportConditions: ['node', 'require', 'default'],
  },
  moduleNameMapper: {
    // base58-js's exports map only declares an `import` condition;
    // map it directly to the file so Jest's resolver doesn't bail.
    '^base58-js$': '<rootDir>/node_modules/base58-js/index.js',
  },

  // avoids "Do not know how to serialize a BigInt" instead of showing the actual assertion error message
  // see https://github.com/jestjs/jest/issues/11617#issuecomment-1028651059
  maxWorkers: 1,

  // SDK is empty for now -- no specs yet. Don't fail CI on "no tests found".
  passWithNoTests: true,
};
