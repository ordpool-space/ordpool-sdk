/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  // this test runs in a normal node environment
  testEnvironment: 'node',

  // Angular-DI specs (anything that imports @angular/core directly)
  // live in *.angular.spec.ts and run only under the browser config,
  // where jest-preset-angular handles the @angular/* ESM transforms.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '\\.angular\\.spec\\.ts$'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],

  // avoids "Do not know how to serialize a BigInt" instead of showing the actual assertion error message
  // see https://github.com/jestjs/jest/issues/11617#issuecomment-1028651059
  maxWorkers: 1,

  // SDK is empty for now -- no specs yet. Don't fail CI on "no tests found".
  passWithNoTests: true,
};
