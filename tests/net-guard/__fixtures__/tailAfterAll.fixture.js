/** BACKLOG-3284 RED-BY-DESIGN fixture: unmocked call in the file's OWN afterAll.
 *  No jest hook can see this one — only the globalTeardown backstop. */
const http = require('http');
afterAll(() => { try { http.request('http://example.invalid/tail').end(); } catch (e) { /* swallowed */ } });
test('RED-BY-DESIGN: passing test whose file cleans up over the network', () => { expect(1).toBe(1); });

// Explicit CommonJS module: keeps top-level names out of the global TypeScript
// declaration space (tsconfig.test.json includes tests/**). See ../install.js.
module.exports = {};
