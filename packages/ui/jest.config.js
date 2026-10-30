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
/**
 * Two projects (BACKLOG-4032 slice 3, SR R2), so both time-zone directions run
 * in the one CI step:
 * - `kit`: every suite, under Pacific/Auckland (UTC+13 in October). A
 *   formatter that builds a local Date and calls toISOString() is a day early.
 * - `kit-tz-west`: the date suites again under Pacific/Honolulu (UTC-10, no DST; differs from a UTC-6 dev machine so a local run proves the zone applied). A
 *   parser that reads `new Date('YYYY-MM-DD').getDate()` is a day early.
 * test/tz-env.js applies `testEnvironmentOptions.tz` before each file loads.
 */
const shared = {
  rootDir: __dirname,
  testEnvironment: '<rootDir>/test/tz-env.js',
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
};

module.exports = {
  projects: [
    {
      ...shared,
      displayName: 'kit',
      testMatch: ['<rootDir>/src/**/*.test.{ts,tsx}'],
      testEnvironmentOptions: { tz: 'Pacific/Auckland' },
    },
    {
      ...shared,
      displayName: 'kit-tz-west',
      testMatch: [
        '<rootDir>/src/components/date-range/**/*.test.{ts,tsx}',
        '<rootDir>/src/components/report/period-picker*.test.{ts,tsx}',
      ],
      testEnvironmentOptions: { tz: 'Pacific/Honolulu' },
    },
  ],
  // Keep output lean.
  verbose: false,
  testTimeout: 15000,
};
