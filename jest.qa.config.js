/**
 * Dedicated Jest config for the deterministic QA harness unit suites
 * (BACKLOG-1848 H1 … BACKLOG-1851 H4).
 *
 * The main `jest.config.js` selects only `src/**` + `electron/**` under CI, so
 * the harness `__tests__` run via THIS config — one command, in any env
 * (`npm run qa:test`). It inherits the base transform/moduleNameMapper but
 * targets only the harness and drops coverage thresholds (a partial run must not
 * trip the repo-wide gate).
 */
const base = require('./jest.config.js');

module.exports = {
  ...base,
  testMatch: ['**/scripts/qa/harness/**/__tests__/**/*.(test|spec).{js,ts}'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/build/'],
  collectCoverage: false,
  coverageThreshold: undefined,
};
