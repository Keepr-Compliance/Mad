/** BACKLOG-3284 RED-BY-DESIGN fixture: unmocked call at MODULE SCOPE.
 *  Caught by the guard's beforeEach, which reports rather than discards. */
const axios = require('axios');
axios.get('https://example.invalid/import-time').catch(() => {});

test('RED-BY-DESIGN: a trivial test after a module-scope unmocked call', () => {
  expect(1 + 1).toBe(2);
});

// Explicit CommonJS module: keeps top-level names out of the global TypeScript
// declaration space (tsconfig.test.json includes tests/**). See ../install.js.
module.exports = {};
