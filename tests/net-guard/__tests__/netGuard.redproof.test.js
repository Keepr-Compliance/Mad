/**
 * BACKLOG-3284 — the red-proof. Drives the red-by-design fixtures as a SUBPROCESS and
 * asserts they fail, by NAME, from --json. A red-by-design case cannot live in a
 * tracked test file; this is how it is still proven on every CI run.
 *
 * Three mechanisms, asserted differently on purpose:
 *   - hook-caught (beforeEach / afterEach) -> jest writes --json; assert test NAMES
 *   - backstop-caught (globalTeardown)     -> a throwing globalTeardown SUPPRESSES
 *                                             --json entirely; assert exit 1 and the
 *                                             named hosts on stderr
 *   - sibling-record collision             -> two files in ONE worker, ordered; assert
 *                                             the backstop reports BOTH
 *
 * Exit code alone discriminates none of the three on its own: a weakened guard still
 * exits 1 while under-reporting. Every case asserts counts and names.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const JEST_BIN = path.join(ROOT, 'node_modules/jest/bin/jest.js');
const FIXTURES = path.join(ROOT, 'tests/net-guard/__fixtures__');
const SEQUENCER = path.join(FIXTURES, 'orderedSequencer.js');

function runFixtures(globs, opts = {}) {
  // mkdtemp per call, removed in the finally: two per run on every developer and CI
  // machine otherwise, and nothing ever collects them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netguard-redproof-'));
  try {
    const out = path.join(dir, 'run.json');
    const args = [JEST_BIN, '--bail=0', '--json', `--outputFile=${out}`, ...(opts.extraArgs || [])];
    for (const g of globs) args.push('--testMatch', g);
    const res = spawnSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      // The child's own globalSetup mints its OWN record dir, so it can never write
      // into the parent run's record and trip the parent's backstop.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CI: '', ...(opts.env || {}) },
    });
    let json = null;
    if (fs.existsSync(out)) { try { json = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_) {} }
    return { status: res.status, stderr: res.stderr || '', json };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// "Tests: 0 total" is indistinguishable from "all tests passed" if only the exit code
// is read, and --json is suppressed whenever the backstop throws. Read the count off
// the summary line instead, and require it to be non-zero.
function totalTestsFromStderr(stderr) {
  const m = stderr.match(/Tests:.*?(\d+) total/);
  return m ? Number(m[1]) : 0;
}

jest.setTimeout(180000);

test('RED-PROOF: hook-caught shapes fail, by name', () => {
  const r = runFixtures(['**/tests/net-guard/__fixtures__/swallowed.fixture.js',
                         '**/tests/net-guard/__fixtures__/importTime.fixture.js']);
  expect(r.status).toBe(1);
  expect(r.json).not.toBeNull();
  expect(r.json.numTotalTests).toBeGreaterThan(0); // "Tests: 0 total" is a FAILURE
  const failed = r.json.testResults
    .flatMap((t) => t.assertionResults)
    .filter((a) => a.status === 'failed')
    .map((a) => a.fullName)
    .sort();
  expect(failed).toEqual([
    'RED-BY-DESIGN: a trivial test after a module-scope unmocked call',
    'RED-BY-DESIGN: swallowing handler returns success',
  ]);
});

test('RED-PROOF: backstop-only shapes fail the run with no jest hook involved', () => {
  const r = runFixtures(['**/tests/net-guard/__fixtures__/tailAfterAll.fixture.js',
                         '**/tests/net-guard/__fixtures__/skippedImport.fixture.js']);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('NET_GUARD BACKSTOP');
  expect(r.stderr).toContain('tailAfterAll.fixture.js');
  expect(r.stderr).toContain('skippedImport.fixture.js');
  // Every test in that run PASSED. The run is red anyway — that is the point.
  expect(totalTestsFromStderr(r.stderr)).toBeGreaterThan(0);
  expect(r.stderr).not.toMatch(/Tests:.*\d+ failed/);
  // And --json is suppressed by the throwing globalTeardown: a verification step that
  // parses it must read "exit 1, no JSON" as a backstop failure.
  expect(r.json).toBeNull();
});

test("RED-PROOF: a consuming file does not delete a sibling file's unreported record", () => {
  // Both files in ONE worker (--runInBand), tailAfterAll FIRST (--testSequencer): a
  // consuming file can only delete a record that is already in the worker's record
  // file, so the order IS the experiment. Regression control for the two halves of
  // the collision fix — the per-record `seq` living on the `net` core-module object
  // (not on a per-test-file `globalThis`), and a consume() that rewrites the file by
  // id instead of truncating it. Revert either and this case reports 1 record, not 2.
  const r = runFixtures(['**/tests/net-guard/__fixtures__/tailAfterAll.fixture.js',
                         '**/tests/net-guard/__fixtures__/consumingSibling.fixture.js'],
    {
      extraArgs: ['--runInBand', `--testSequencer=${SEQUENCER}`],
      env: { KEEPR_NET_GUARD_FIXTURE_ORDER: 'tailAfterAll.fixture.js,consumingSibling.fixture.js' },
    });
  expect(r.status).toBe(1);
  expect(r.json).toBeNull();
  expect(totalTestsFromStderr(r.stderr)).toBeGreaterThan(0);
  expect(r.stderr).not.toMatch(/Tests:.*\d+ failed/);
  expect(r.stderr).toContain('NET_GUARD BACKSTOP: 2 blocked connection(s)');
  const backstop = r.stderr.slice(r.stderr.indexOf('NET_GUARD BACKSTOP'));
  const tail = backstop.indexOf('tailAfterAll.fixture.js');
  const sibling = backstop.indexOf('consumingSibling.fixture.js');
  expect(tail).toBeGreaterThan(-1);
  expect(sibling).toBeGreaterThan(-1);
  // The backstop lists records in append order, so this also proves the sequencer
  // applied: with the consuming file first there is no collision to detect and the
  // case would be vacuous.
  expect(tail).toBeLessThan(sibling);
});

// Explicit CommonJS module: keeps top-level names out of the global TypeScript
// declaration space (tsconfig.test.json includes tests/**). See ../install.js.
module.exports = {};
