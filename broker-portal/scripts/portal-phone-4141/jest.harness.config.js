/** BACKLOG-4141: jest config for the login + support-form phone-width harness only (run.sh). Not used by CI. */
const portal = require('../../jest.config');
module.exports = { ...portal, testMatch: ['<rootDir>/scripts/portal-phone-4141/*.harness.tsx'] };
