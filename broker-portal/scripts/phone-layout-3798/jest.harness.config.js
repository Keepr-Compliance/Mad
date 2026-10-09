/**
 * BACKLOG-3798: jest config for the layout harness only (run.sh). Not used by CI.
 */
const portal = require('../../jest.config');

module.exports = {
  ...portal,
  testMatch: ['<rootDir>/scripts/phone-layout-3798/*.harness.tsx'],
};
