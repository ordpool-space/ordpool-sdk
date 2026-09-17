/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  // this test runs in a normal node environment
  testEnvironment: 'node',

  // RESCUE/ holds code rescued from cat21-wallet (commit 397c997)
  // pending port to the SDK proper. Its specs import @leather.io/*
  // packages that aren't in the SDK's node_modules, so they fail
  // outside the wallet's own monorepo. Skip until the port lands.
  // `.browser.spec.ts` needs jsdom globals (wallet signers reading
  // `window.<wallet>`, WebCrypto), so it runs only under the browser
  // config; the node config skips it.
  // `/e2e/` is skipped because those specs need a live regtest stack or a real
  // browser. Harness code in there still deserves unit tests, and without a
  // home for them a helper's branches only ever run when the rare condition
  // they guard actually occurs, which is the case they exist for. So
  // `*.unit.spec.ts` under e2e/ runs here: pure logic, stubbed inputs, no
  // stack, no browser.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/e2e/(?!.*\\.unit\\.spec\\.ts$)',
    '/RESCUE/',
    '\\.browser\\.spec\\.ts$',
  ],
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
    // Source imports carry explicit `.js` extensions so the ESM build is
  // resolvable by Node. Jest compiles the .ts sources, so strip the
  // extension back off. (ESM-extension mapping)
  moduleNameMapper: {
    '^(\.{1,2}/.*)\.js$': '$1',
    // base58-js's exports map only declares an `import` condition;
    // map it directly to the file so Jest's resolver doesn't bail.
    '^base58-js$': '<rootDir>/node_modules/base58-js/index.js',
  },

  // avoids "Do not know how to serialize a BigInt" instead of showing the actual assertion error message
  // see https://github.com/jestjs/jest/issues/11617#issuecomment-1028651059
  maxWorkers: 1,

  // A run matching zero tests is a broken filter, not a pass: with 90+
  // spec files, "no tests found" means testPathIgnorePatterns (or a CLI
  // filter typo) silently excluded everything.
  passWithNoTests: false,
};
