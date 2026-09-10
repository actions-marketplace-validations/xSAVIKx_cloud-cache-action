/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/restore.ts',
    '!src/save.ts',
    '!src/restoreOnly.ts',
    '!src/saveOnly.ts',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
  clearMocks: true,
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
};
