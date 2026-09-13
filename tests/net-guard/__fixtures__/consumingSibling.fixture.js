/**
 * BACKLOG-3284 fixture — GREEN by design, unlike the other four.
 *
 * It plays the part every ordinary suite plays: it provokes a blocked connection
 * inside a test and consumes the record the way assert.js's hooks do, so the file
 * itself passes. Then it makes one more blocked call in its own afterAll, which no
 * hook can see and only the backstop reports.
 *
 * What the pairing proves: consuming its OWN record must not remove a record written
 * by a DIFFERENT test file in the same worker. The record file is per WORKER; the
 * in-memory array is per TEST FILE. Run SECOND, after tailAfterAll.fixture.js, by
 * ./orderedSequencer.js — a consuming file can only delete a record that is already
 * in the file, so the order is the whole experiment.
 */
const http = require('http');

afterAll(() => {
  try { http.request('http://example.invalid/sibling-tail').end(); } catch (e) { /* the backstop's job */ }
});

test("consuming this file's own record leaves a sibling file's record alone", () => {
  try { http.request('http://example.invalid/sibling-consumed').end(); } catch (e) { /* expected */ }
  const consumed = global.__KEEPR_NET_CONSUME__() || [];
  expect(consumed.map((r) => `${r.host}:${r.port}`)).toEqual(['example.invalid:80']);
});

// Explicit CommonJS module: keeps top-level names out of the global TypeScript
// declaration space (tsconfig.test.json includes tests/**). See ../install.js.
module.exports = {};
