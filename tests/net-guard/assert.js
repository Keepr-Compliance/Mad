/**
 * BACKLOG-3284 — the half a throw cannot do. Runs from jest `setupFilesAfterEnv`,
 * where the test framework is available. See install.js for the whole design.
 *
 * A guard that only throws is swallowed by any production catch block. These hooks
 * are what turn a blocked connection into a failing test.
 */
const state = expect.getState();
global.__KEEPR_TEST_PATH__ = state && state.testPath ? state.testPath : "(unknown)";

// Consume clears the in-memory array AND the durable record together, so an attempt
// this hook reports is not re-reported by the globalTeardown backstop.
function drain() {
  return global.__KEEPR_NET_CONSUME__ ? global.__KEEPR_NET_CONSUME__() : null;
}

function fail(blocked, when) {
  const list = blocked.map((a) => `  - ${a.host}:${a.port}`).join("\n");
  throw new Error(
    `NET_GUARD: ${blocked.length} outbound network connection(s) attempted ${when}:\n${list}\n` +
      `A missing mock must be a red test, not a live request. (BACKLOG-3284)`
  );
}

// NEVER drain silently. A module-scope client (`axios.get(...)` at import), a
// beforeAll, or a fire-and-forget call whose socket lands after its own afterEach all
// record OUTSIDE a test body — and a beforeEach that discards instead of checking
// turns every one of them GREEN. Measured: a module-scope control passed under
// exactly that shape. Whichever hook runs first now reports it.
beforeEach(() => {
  const blocked = drain();
  if (blocked) fail(blocked, "before this test ran (import time, beforeAll, or a previous test's teardown)");
});

afterEach(() => {
  const blocked = drain();
  if (blocked) fail(blocked, "by this test");
});

// This afterAll runs BEFORE a test file's own afterAll. An attempt made there is
// recorded after every hook has already checked, and there is no next hook at the end
// of a file — that is what globalTeardown.js exists for.
afterAll(() => {
  const blocked = drain();
  if (blocked) fail(blocked, "outside any test body (import time / afterAll) in this suite");
});

// Explicit CommonJS module: keeps top-level names out of the global TypeScript
// declaration space (tsconfig.test.json includes tests/**). See ../install.js.
module.exports = {};
