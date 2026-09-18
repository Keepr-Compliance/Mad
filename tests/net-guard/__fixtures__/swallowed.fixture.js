/**
 * BACKLOG-3284 RED-BY-DESIGN fixture. Named .fixture.js so neither jest's testMatch
 * nor scripts/ci/check-test-drift.mjs claims it. Run only as a subprocess by
 * ../__tests__/netGuard.redproof.test.js.
 *
 * Shape: a handler that catches, reports an outcome, and returns success. A guard
 * that only THROWS leaves this green with the mock still missing — which is why the
 * assertion half of the guard exists.
 */
const axios = require('axios');

async function handlerThatSwallows() {
  let outcome = 'unsupported';
  try { await axios.post('https://example.invalid/endpoint'); outcome = 'ok'; }
  catch (e) { outcome = 'failed'; }
  return { success: true, outcome };
}

test('RED-BY-DESIGN: swallowing handler returns success', async () => {
  const result = await handlerThatSwallows();
  expect(result.success).toBe(true);
});

// Explicit CommonJS module: keeps top-level names out of the global TypeScript
// declaration space (tsconfig.test.json includes tests/**). See ../install.js.
module.exports = {};
