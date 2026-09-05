/**
 * Tests for scripts/ci/audit-guard.mjs — the `Security Audit` job's pass/fail decision
 * (BACKLOG-3101).
 *
 * Runs in CI: jest.config.js `testMatch` includes '<rootDir>/scripts/__tests__/**', the
 * glob BACKLOG-2678 added for afterPack.test.ts.
 *
 * ## The fixtures are transcripts, not inventions
 *
 * Every file in fixtures/audit-guard/ is real output, captured — not typed from memory.
 * The point of this suite is to tell an infra failure apart from a real advisory, and a
 * hand-written fixture would be describing the difference rather than testing it.
 *
 *   registry-503.txt          GitHub Actions job 100920494994 (run 33840093393),
 *                             2026-09-04 — the 503 that took a required check red on
 *                             develop and caused BACKLOG-3101. Timestamps and `##[...]`
 *                             runner lines stripped; npm's own lines verbatim.
 *   endpoint-retired-400.txt  GitHub Actions job 89762984028, 2026-07-26 — the
 *                             "endpoint is being retired" 400 that BACKLOG-2265 was
 *                             filed for, captured the same way.
 *   critical-advisory.txt     `npm audit --audit-level=critical` (npm 10.9.4) against a
 *                             throwaway package.json pinning shell-quote@1.6.0
 *                             (GHSA-qg8p-v9q4-gh34, critical). npm exited 1.
 *   high-only-advisories.txt  Same, pinning ansi-regex@4.1.0 + braces@3.0.2 — two high,
 *                             zero critical. npm exited 0 under --audit-level=critical.
 *   clean.txt                 Same, no dependencies. npm exited 0.
 *
 * The guard is spawned as a subprocess rather than imported. That runs the exact CLI
 * contract ci.yml invokes — argument parsing, stdin, exit code — instead of a function
 * the workflow never calls, and avoids loading an ESM module under jest's CJS transform.
 */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import * as path from 'path';

const GUARD = path.resolve(__dirname, '../ci/audit-guard.mjs');
const FIXTURES = path.resolve(__dirname, 'fixtures/audit-guard');

const transcript = (name: string): string =>
  readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8');

/** Runs the guard exactly as .github/workflows/ci.yml does. */
function runGuard(output: string, npmExitCode: number) {
  const res = spawnSync(process.execPath, [GUARD, '--npm-exit-code', String(npmExitCode)], {
    input: output,
    encoding: 'utf8',
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('audit-guard: registry infra failures are tolerated', () => {
  // Control 1. Remove the tolerance (the `output.includes(INFRA_MARKER)` branch) and
  // this test plus the 400 one below go red — 2 failures.
  it('exits 0 on the real 2026-09-04 503 transcript and emits a warning', () => {
    const { code, stdout } = runGuard(transcript('registry-503'), 1);
    expect(code).toBe(0);
    expect(stdout).toContain('::warning::');
    expect(stdout).toContain('BACKLOG-3101');
  });

  // Control 3. Proves the rewrite from BACKLOG-2265's grep list to npm's single marker
  // line did not drop the case 2265 already covered.
  it('exits 0 on the BACKLOG-2265 "endpoint is being retired" 400 transcript', () => {
    const { code, stdout } = runGuard(transcript('endpoint-retired-400'), 1);
    expect(code).toBe(0);
    expect(stdout).toContain('::warning::');
  });

  it('keys on npm\'s marker line, which both infra transcripts carry', () => {
    // If npm ever stops printing this line, the two tests above would still pass for the
    // wrong reason. This asserts the actual discriminator is present in the inputs.
    expect(transcript('registry-503')).toContain('audit endpoint returned an error');
    expect(transcript('endpoint-retired-400')).toContain('audit endpoint returned an error');
  });
});

describe('audit-guard: real advisories still fail', () => {
  // Control 2 — the one that matters. A tolerance written too broadly swallows the real
  // failure, and this is the only test that can tell the two apart.
  it('exits 1 on a real critical advisory and emits no warning', () => {
    const { code, stdout } = runGuard(transcript('critical-advisory'), 1);
    expect(code).toBe(1);
    expect(stdout).not.toContain('::warning::');
  });

  it('a critical advisory report contains neither the marker nor any "npm error" line', () => {
    // Both halves are load-bearing. The first is why one condition is safe. The second
    // records why the obvious over-broad mutation (`includes('npm error')`) does NOT
    // turn the test above red: npm writes the advisory report to stdout unprefixed, so
    // that widening is under-broad here rather than over-broad. The mutation that DOES
    // catch it is `includes('npm')` — the report has "# npm audit report".
    const report = transcript('critical-advisory');
    expect(report).not.toContain('audit endpoint returned an error');
    expect(report).not.toContain('npm error');
    expect(report).toContain('1 critical severity vulnerability');
  });
});

describe('audit-guard: successful audits pass through', () => {
  // Control 4.
  it('exits 0 when npm exited 0 on a clean tree', () => {
    const { code, stdout } = runGuard(transcript('clean'), 0);
    expect(code).toBe(0);
    expect(stdout).not.toContain('::warning::');
  });

  // Control 5. --audit-level=critical means high/moderate findings are not this check's
  // business; npm exits 0 and the guard must not invent a failure.
  it('exits 0 on high-severity-only advisories (npm exited 0 under --audit-level=critical)', () => {
    const { code, stdout } = runGuard(transcript('high-only-advisories'), 0);
    expect(code).toBe(0);
    expect(stdout).not.toContain('::warning::');
    expect(transcript('high-only-advisories')).toContain('2 high severity vulnerabilities');
  });

  it('forwards an unrecognised non-zero exit code unchanged', () => {
    const { code } = runGuard('some unfamiliar npm failure\n', 7);
    expect(code).toBe(7);
  });
});

describe('audit-guard: fails closed on bad invocation', () => {
  it('exits 1 when --npm-exit-code is missing', () => {
    const res = spawnSync(process.execPath, [GUARD], { input: '', encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('usage');
  });

  it('exits 1 when --npm-exit-code is not an integer', () => {
    const res = spawnSync(process.execPath, [GUARD, '--npm-exit-code', 'nope'], {
      input: '',
      encoding: 'utf8',
    });
    expect(res.status).toBe(1);
  });
});
