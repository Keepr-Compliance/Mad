/** BACKLOG-4139/4140: jest config for the billing phone-width harness only (run.sh). Not used by CI. */
const portal = require('../../jest.config');
module.exports = { ...portal, testMatch: ['<rootDir>/scripts/billing-phone-4139/*.harness.tsx'] };
