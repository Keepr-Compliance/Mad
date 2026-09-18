/**
 * Jest config for broker-portal tests.
 *
 * Extends the root config but overrides moduleNameMapper to resolve
 * @/ imports to the broker-portal root (not src/).
 *
 * TASK-2199: Support Ticket Notification Emails
 */

const rootConfig = require('../jest.config');

module.exports = {
  ...rootConfig,
  // Override root paths for broker-portal
  rootDir: __dirname,
  roots: ['<rootDir>'],
  setupFiles: [],
  setupFilesAfterEnv: [],
  // BACKLOG-3284: the root config's network guard is scoped to the desktop app's
  // jest tiers. This portal spreads the root config, so its `<rootDir>`-relative
  // globalSetup/globalTeardown paths would resolve against broker-portal/ and jest
  // would refuse to start ("Module <rootDir>/tests/net-guard/globalSetup.js in the
  // globalSetup option was not found"). Cleared here for the same reason
  // setupFiles/setupFilesAfterEnv above are cleared: this portal runs its own
  // harness. Adopting the guard here would be its own change.
  globalSetup: undefined,
  globalTeardown: undefined,
  transform: {
    ...rootConfig.transform,
    // Same ts-jest setup as root, plus the react/react-dom type pins from
    // tsconfig.json: design-system source lives outside broker-portal and
    // would otherwise resolve the repo root's @types/react v19, clashing
    // with this portal's v18 types in ts-jest diagnostics.
    '^.+\\.(ts|tsx)$': ['ts-jest', {
      tsconfig: {
        jsx: 'react-jsx',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        resolveJsonModule: true,
        baseUrl: '.',
        paths: {
          react: ['./node_modules/@types/react'],
          'react-dom': ['./node_modules/@types/react-dom'],
        },
      },
    }],
  },
  moduleNameMapper: {
    ...rootConfig.moduleNameMapper,
    // Override @/ to point to broker-portal root
    '^@/(.*)$': '<rootDir>/$1',
    '^@shared/(.*)$': '<rootDir>/../shared/$1',
    // Design-system ships raw TS source; map it so jest transforms it as
    // project source instead of hitting untranspiled node_modules
    '^@keepr/design-system$': '<rootDir>/../packages/design-system/src/index.ts',
    // @keepr/ui likewise ships raw TS source (shadcn/Radix components) — map it
    // to source so ts-jest transforms it instead of hitting untranspiled
    // node_modules (BACKLOG-1750 wave C adoption).
    '^@keepr/ui$': '<rootDir>/../packages/ui/src/index.ts',
  },
  testMatch: [
    '**/__tests__/**/*.(test|spec).{js,jsx,ts,tsx}',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/.next/',
  ],
  // Disable root coverage thresholds
  coverageThreshold: undefined,
  collectCoverageFrom: [
    'lib/**/*.{ts,tsx}',
    'app/**/*.{ts,tsx}',
    '!**/*.d.ts',
  ],
};
