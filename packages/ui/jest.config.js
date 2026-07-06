/**
 * Dedicated jest config for @keepr/ui.
 *
 * Runs in isolation from the root electron/app suite: the root config adds
 * `/packages/` to `testPathIgnorePatterns`, and CI's root `testMatch` only
 * covers `src/**` + `electron/**`, so these tests never run under the app
 * runner (which mocks native modules and enforces electron coverage
 * thresholds). Invoke via `npm test -w @keepr/ui` or
 * `npx jest --config packages/ui/jest.config.js`.
 *
 * ts-jest + jsdom; the Radix polyfills live in ./test/setup.ts.
 */
module.exports = {
  rootDir: '.',
  testEnvironment: 'jest-environment-jsdom',
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'react-jsx',
          module: 'commonjs',
          isolatedModules: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          resolveJsonModule: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
  },
  testMatch: ['<rootDir>/src/**/*.test.{ts,tsx}'],
  // Keep output lean.
  verbose: false,
  testTimeout: 15000,
};
