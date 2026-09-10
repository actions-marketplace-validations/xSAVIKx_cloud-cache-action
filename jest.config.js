/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'node',
          target: 'ES2022',
        },
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: ['node_modules/(?!(@actions)/)'],
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
