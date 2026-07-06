/**
 * Jest config for the INTEGRATION TEST TIER (BACKLOG-1786).
 *
 * The integration tier exercises the business-critical pipeline end-to-end:
 *   sync (fake Gmail/Outlook/iOS providers) -> classification -> transaction detection
 * using deterministic, offline fixtures (see tests/integration/README.md).
 *
 * Why a separate config instead of folding into the main jest.config.js:
 *   1. The main CI `testMatch` only selects src/** and electron/**; the integration
 *      suite lives under tests/integration/ and would otherwise never be picked up.
 *   2. The main config enforces per-path coverage thresholds and `bail: 1`. We do
 *      NOT want a single integration failure to abort the whole unit run, nor do we
 *      want integration coverage to perturb the unit coverage gate.
 *   3. Keeping the tier isolated lets it run as its own CI step with its own flags.
 *
 * This config inherits transforms, module mappers, and setup files from the base
 * config so the two tiers stay in sync, and only overrides test selection + gating.
 */
const base = require('./jest.config');

module.exports = {
  ...base,

  // Only run the integration pipeline suite.
  testMatch: ['**/tests/integration/**/*.(test|spec).{js,jsx,ts,tsx}'],

  // Quarantine list for integration suites that are genuinely unstable.
  // Add a file here (with a tracking comment) rather than disabling the whole tier.
  // As of BACKLOG-1786: none quarantined — the full tier passes deterministically.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/build/',
    '/\\.claude/worktrees/',
    '/worktrees/',
  ],

  // The unit config owns the coverage gate; the integration tier is not a
  // coverage target and its numbers should not affect thresholds.
  collectCoverage: false,
  coverageThreshold: undefined,

  // Surface ALL integration failures in one run (the base config bails on first).
  bail: 0,
};
