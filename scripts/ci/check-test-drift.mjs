#!/usr/bin/env node
/**
 * TEST-DRIFT GATE (BACKLOG-2678)
 *
 * Fails the build when a tracked test file is run by NO CI test config.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * `jest.config.js` used entirely different `testMatch` lists under CI and
 * locally. A file matched only by the local list ran on a developer machine and
 * in the pre-push hook, and NEVER in CI — so it could rot indefinitely while
 * every status check stayed green. Measured on develop @ 6179e97f: 622 tracked
 * test files, 47 of them run by no CI job at all, 31 of those being the QA
 * harness's own suites — the machinery built to catch regressions was not
 * itself guarded, and two of its suites were red.
 *
 * Converging the globs fixed that day's gap. This script is what stops the gap
 * from reopening: an orphaned test file BREAKS THE BUILD instead of appearing
 * in a report nobody reads.
 *
 * ---------------------------------------------------------------------------
 * How it decides
 * ---------------------------------------------------------------------------
 * EXPECTED  = every tracked `*.(test|spec).*` file (`git ls-files`).
 * COVERED   = the union of the file lists the REAL configs report, obtained by
 *             asking each runner itself (`jest --listTests`, `vitest list
 *             --filesOnly`) rather than by reimplementing glob matching here.
 *             A second implementation of the matching rules would drift from
 *             the configs exactly the way the configs drifted from each other.
 * ALLOWED   = the explicit, commented allow-list below.
 *
 * Any EXPECTED file that is neither COVERED nor ALLOWED is an orphan -> exit 1.
 *
 * ---------------------------------------------------------------------------
 * Three failure modes, not one
 * ---------------------------------------------------------------------------
 * A gate that has never reported anything is indistinguishable from a gate that
 * CANNOT report, so this script fails on all three of:
 *
 *   1. ORPHAN            a tracked test file no config selects.
 *   2. DEAD PROBE        a config whose listing command exits non-zero, OR
 *                        reports ZERO files. Zero files means that config
 *                        contributed nothing to COVERED, which would silently
 *                        turn all of its files into orphans (noisy) or, worse,
 *                        mask a config that has stopped selecting anything.
 *   3. STALE ALLOW-LIST  an allow-list entry matching no tracked file. Entries
 *                        are exemptions, and an exemption for a file that no
 *                        longer exists is a lie that hides the next one.
 *
 * The allow-list is PRINTED ON EVERY RUN, pass or fail. An exemption you cannot
 * see is a silent skip.
 *
 * ---------------------------------------------------------------------------
 * ...and one NON-failure: this machine cannot run the probes (BACKLOG-2732)
 * ---------------------------------------------------------------------------
 * All three modes above are statements ABOUT THE REPOSITORY. A fourth condition
 * looks identical in the output and is nothing of the kind: the runners are not
 * installed for this checkout, every probe dies on
 * "jest-environment-jsdom cannot be found", COVERED comes back empty and the
 * gate declares 804 of 821 tracked test files orphaned.
 *
 * That red is entirely about the machine. Left as-is it does three harmful
 * things: it buries any real finding under 804 fake ones, it trains readers to
 * disbelieve the gate, and it points at the one remedy that must not be taken —
 * `npm install` inside a git worktree, which rewrites the SHARED native sqlite
 * binary through the symlinked `node_modules` and breaks the running dev app.
 *
 * So preflightEnvironment() runs FIRST and, if the runners cannot resolve, the
 * script exits 2 having printed no coverage or drift output at all. Exit 1 keeps
 * its single meaning: a real problem with the repository.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * EXIT CODES. Three outcomes, because "the gate says no" and "the gate cannot
 * speak" are different facts and a caller must be able to tell them apart.
 *
 *   0  measured, nothing wrong.
 *   1  measured, and there is a PROBLEM WITH THE REPOSITORY (orphan / dead
 *      probe / stale allow-list entry).
 *   2  NOT MEASURED — this machine cannot run the probes. Says nothing at all
 *      about the repository. (2 rather than 75: scripts/test-with-restore.js
 *      already owns 75 for the native-module restore failure, and reusing it
 *      would make two unrelated conditions look like one.)
 */
const EXIT_PROBLEM = 1;
const EXIT_ENVIRONMENT = 2;

/** Tracked files with these extensions and a .test./.spec. infix are test files. */
const TEST_FILE_RE = /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$/;

// ---------------------------------------------------------------------------
// ALLOW-LIST — files deliberately run by no jest/vitest CI config.
//
// Every entry needs a reason and, where the exemption is a gap rather than a
// property of the file, a filed backlog item. "It was failing" is NOT a reason;
// fix it or file it. Patterns are matched against repo-relative POSIX paths.
// ---------------------------------------------------------------------------
const ALLOW_LIST = [
  {
    // Playwright specs. They import @playwright/test and drive a real Electron
    // launch (`npm run qa:e2e`), so they cannot execute under jest — dragging
    // them into the Node run would fail the pipeline, not gate it. This is the
    // same reasoning the jest.config.js comment gives for keeping future E2E
    // specs OUT of e2e/driver/__tests__, and it is correct.
    pattern: /^e2e\/tests\/.*\.spec\.ts$/,
    reason: 'Playwright specs — need a real app launch (npm run qa:e2e); cannot run under jest',
  },
  {
    // admin-portal's Playwright suite (`npm run test:e2e -w admin-portal`),
    // separate from its vitest unit suite. Same reasoning as above.
    pattern: /^admin-portal\/e2e\/.*\.spec\.ts$/,
    reason: 'Playwright specs — admin-portal e2e suite (npm run test:e2e), not vitest',
  },
  {
    // Supabase Edge Function tests are Deno, not Node: they import from
    // https://deno.land/std/... and use Deno.test. No jest/vitest config can
    // run them and there is currently no CI job that runs `deno test`.
    // GAP, not a property of the files — tracked in BACKLOG-2690.
    pattern: /^supabase\/functions\/.*\/__tests__\/.*\.test\.ts$/,
    reason: 'Deno tests (deno.land imports / Deno.test) — no deno CI job yet, see BACKLOG-2690',
  },
  {
    // QUARANTINE, not an exemption on the merits. This guard is RED and the red
    // is CORRECT — it reports that the QA seeder stamps HEAD_SCHEMA_VERSION = 50
    // while the head migration is 57 — but satisfying it by bumping the constant
    // would BREAK the fixture, because schema.sql lacks what migrations v56/v57
    // add. See the long note beside the matching testPathIgnorePatterns entry in
    // jest.config.js. Un-quarantining is part of closing BACKLOG-2687.
    pattern: /^scripts\/qa\/harness\/__tests__\/headSchemaVersion\.test\.ts$/,
    reason: 'QUARANTINED RED — correct failure, wrong fix is to bump the constant; see BACKLOG-2687',
  },
];

// ---------------------------------------------------------------------------
// PROBES — one per CI test config. `cwd` is relative to the repo root; `list`
// is spawned there and must print one test file path per line.
//
// Keep this list in step with .github/workflows/ci.yml. A config that CI runs
// but that is missing here makes its files look orphaned (loud, self-correcting).
// A config listed here that CI does NOT run is the dangerous direction: it would
// mark files covered that nothing executes. Only add a probe for a config with a
// real CI step.
// ---------------------------------------------------------------------------
const PROBES = [
  {
    name: 'root jest (CI testMatch)',
    ciStep: 'ci.yml "Run tests"',
    cwd: '.',
    // Resolved from `cwd` before probing — see preflightEnvironment().
    requires: ['jest', 'jest-environment-jsdom'],
    cmd: 'npx',
    args: ['jest', '--listTests'],
    // The root config branches on process.env.CI for BOTH testMatch and
    // testPathIgnorePatterns. Listing without it would describe the LOCAL
    // selection, i.e. the wrong set entirely.
    env: { CI: 'true' },
  },
  {
    name: 'integration tier',
    ciStep: 'ci.yml "Run integration test tier"',
    cwd: '.',
    // Resolved from `cwd` before probing — see preflightEnvironment().
    requires: ['jest', 'jest-environment-jsdom'],
    cmd: 'npx',
    args: ['jest', '--config', 'jest.integration.config.js', '--listTests'],
    env: { CI: 'true' },
  },
  {
    name: 'broker-portal jest',
    ciStep: 'ci.yml "Run broker-portal tests"',
    cwd: '.',
    // Resolved from `cwd` before probing — see preflightEnvironment().
    requires: ['jest', 'jest-environment-jsdom'],
    cmd: 'npx',
    args: ['jest', '--config', 'broker-portal/jest.config.js', '--listTests'],
    env: { CI: 'true' },
  },
  {
    name: 'admin-portal vitest',
    ciStep: 'ci.yml "Run admin-portal tests"',
    cwd: 'admin-portal',
    // Resolved from `cwd` before probing — see preflightEnvironment().
    requires: ['vitest'],
    cmd: 'npx',
    args: ['vitest', 'list', '--filesOnly'],
    env: { CI: 'true' },
  },
  {
    name: '@keepr/ui',
    ciStep: 'ci.yml "Test (@keepr/ui)" (packages-ui job)',
    cwd: 'packages/ui',
    // Resolved from `cwd` before probing — see preflightEnvironment().
    requires: ['jest', 'jest-environment-jsdom'],
    cmd: 'npx',
    args: ['jest', '--listTests'],
    env: { CI: 'true' },
  },
  {
    name: 'android-companion',
    ciStep: 'ci.yml "Run tests" (android-companion job)',
    cwd: 'android-companion',
    cmd: 'npx',
    args: ['jest', '--listTests'],
    env: { CI: 'true' },
    // Own lockfile + its own node_modules (jest-expo preset). Not a workspace,
    // so the root install does not provide it.
    needs: 'android-companion/node_modules',
  },
];

// ---------------------------------------------------------------------------

function toPosix(p) {
  return p.split(sep).join('/');
}

/** Repo-relative POSIX path, or null if the path escapes the repo. */
function toRepoRelative(absOrRel, cwdAbs) {
  const abs = resolve(cwdAbs, absOrRel);
  const rel = toPosix(relative(REPO_ROOT, abs));
  if (rel.startsWith('../')) return null;
  return rel;
}

function trackedTestFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((f) => f && TEST_FILE_RE.test(f));
}

/**
 * Run one probe. Never throws — a probe failure is a RESULT (a dead probe),
 * because a gate that crashes on a broken probe reports nothing at all.
 */
function runProbe(probe) {
  const cwdAbs = resolve(REPO_ROOT, probe.cwd);

  if (probe.needs && !existsSync(resolve(REPO_ROOT, probe.needs))) {
    return {
      ...probe,
      ok: false,
      files: [],
      error:
        `missing ${probe.needs} — this project has its own lockfile and is NOT an npm workspace, ` +
        `so the root install does not provide it.\n` +
        `  In CI: the drift job installs it (see .github/workflows/ci.yml, test-drift job).\n` +
        `  Locally: npm ci --prefix ${probe.cwd}`,
    };
  }

  let stdout;
  try {
    stdout = execFileSync(probe.cmd, probe.args, {
      cwd: cwdAbs,
      encoding: 'utf8',
      env: { ...process.env, ...probe.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const detail = [err.stderr, err.stdout].filter(Boolean).join('\n').trim();
    return {
      ...probe,
      ok: false,
      files: [],
      error: `\`${probe.cmd} ${probe.args.join(' ')}\` exited ${err.status ?? '?'}\n${detail.slice(0, 2000)}`,
    };
  }

  const files = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && TEST_FILE_RE.test(l))
    .map((l) => toRepoRelative(l, cwdAbs))
    .filter(Boolean);

  if (files.length === 0) {
    return {
      ...probe,
      ok: false,
      files: [],
      error:
        'reported ZERO test files. A config that selects nothing cannot distinguish "no drift" ' +
        'from "not looking", so this is a failure, not a pass.',
    };
  }

  return { ...probe, ok: true, files, error: null };
}

/**
 * Can `moduleName` be resolved from `fromDirAbs` — the way a runner spawned
 * there would resolve it? Checked with node's own resolver rather than by
 * looking for a `node_modules` directory: a git worktree normally SYMLINKS the
 * canonical checkout's `node_modules`, so directory-existence would call a
 * perfectly runnable worktree broken, and node walks parent directories anyway.
 */
function canResolve(moduleName, fromDirAbs) {
  try {
    createRequire(resolve(fromDirAbs, 'noop.cjs')).resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

/**
 * ENVIRONMENT PREFLIGHT — run BEFORE any probe.
 *
 * A dead probe means one of two completely different things:
 *
 *   (a) the config is broken            -> a finding about the REPOSITORY.
 *   (b) the runner is not installed here -> a fact about THIS MACHINE.
 *
 * Told apart only after the fact, (b) is indistinguishable from (a) — and it
 * mints false findings at scale. Measured on develop @ 6c41a375c:
 *
 *   - a fresh `git worktree add` (no `node_modules` yet): all six probes die on
 *     "Test environment jest-environment-jsdom cannot be found", COVERED is
 *     empty, and the gate reports 804 of 821 tracked test files as orphaned,
 *     "TEST-DRIFT GATE FAILED (7 problems)".
 *   - a checkout without `android-companion/node_modules` (which includes the
 *     canonical one — it is not an npm workspace): 32 orphans reported, and all
 *     32 are android-companion files, i.e. every one belongs to the dead probe.
 *
 * Zero real findings in either run. Worse, the shape of the output invites the
 * fix that must NOT happen: `npm install` inside a worktree rewrites the SHARED
 * native sqlite binary through the symlinked `node_modules` and breaks the
 * running dev app. So this returns EARLY, names the environment, prints no
 * coverage or drift output whatsoever, and exits EXIT_ENVIRONMENT.
 *
 * CI is unaffected: the test-drift job installs everything, preflight passes,
 * and the run proceeds exactly as before.
 */
function preflightEnvironment() {
  const problems = [];

  for (const probe of PROBES) {
    const cwdAbs = resolve(REPO_ROOT, probe.cwd);

    if (probe.needs && !existsSync(resolve(REPO_ROOT, probe.needs))) {
      problems.push(
        `${probe.name}: missing ${probe.needs}\n` +
          `    This project has its own lockfile and is NOT an npm workspace, so the root\n` +
          `    install does not provide it.  Fix: npm ci --prefix ${probe.cwd}`
      );
      continue;
    }

    for (const mod of probe.requires ?? []) {
      if (!canResolve(mod, cwdAbs)) {
        problems.push(
          `${probe.name}: cannot resolve '${mod}' from ${probe.cwd}\n` +
            `    The runner this probe drives is not installed for this checkout.`
        );
      }
    }
  }

  return problems;
}

function main() {
  // --- environment preflight ----------------------------------------------
  // Nothing is printed about the repository until we know we can measure it.
  const envProblems = preflightEnvironment();
  if (envProblems.length > 0) {
    console.error('='.repeat(78));
    console.error('TEST-DRIFT GATE CANNOT RUN HERE — ENVIRONMENT, NOT A FINDING');
    console.error('='.repeat(78));
    console.error('');
    console.error('The test runners this gate interrogates are not installed for this');
    console.error('checkout, so no coverage was measured and NOTHING below would have been');
    console.error('a statement about the repository. No drift is being claimed.');
    console.error('');
    for (const p of envProblems) console.error(`  - ${p}`);
    console.error('');
    console.error('  To measure here, apply the fix each item names above.');
    console.error('  Do NOT reach for a bare `npm install` in a git worktree — worktrees');
    console.error('  symlink the canonical `node_modules`, so installing there rewrites the');
    console.error('  SHARED native sqlite binary and breaks the running dev app. A scoped');
    console.error('  `npm ci --prefix <project>` writes only that project and is safe.');
    console.error('');
    console.error(`Exit ${EXIT_ENVIRONMENT} (environment). Exit 1 would mean a real finding.`);
    process.exit(EXIT_ENVIRONMENT);
  }

  const expected = trackedTestFiles();

  console.log('='.repeat(78));
  console.log('TEST-DRIFT GATE (BACKLOG-2678)');
  console.log('='.repeat(78));
  console.log(`Tracked test files: ${expected.length}`);
  console.log('');

  // --- probes -------------------------------------------------------------
  console.log('Probing each CI test config:');
  const results = PROBES.map(runProbe);
  const covered = new Set();
  for (const r of results) {
    if (r.ok) {
      for (const f of r.files) covered.add(f);
      console.log(`  ok    ${r.name.padEnd(26)} ${String(r.files.length).padStart(4)} files   [${r.ciStep}]`);
    } else {
      console.log(`  DEAD  ${r.name.padEnd(26)}    ?  files   [${r.ciStep}]`);
    }
  }
  console.log('');

  // --- allow-list (always printed) ---------------------------------------
  console.log('Allow-list (files deliberately run by no jest/vitest CI config):');
  const allowMatches = new Map();
  for (const entry of ALLOW_LIST) {
    const matches = expected.filter((f) => entry.pattern.test(f));
    allowMatches.set(entry, matches);
    console.log(`  ${String(matches.length).padStart(3)} file(s)  ${entry.pattern}`);
    console.log(`             reason: ${entry.reason}`);
    for (const m of matches) console.log(`             - ${m}`);
  }
  console.log('');

  const allowed = new Set([...allowMatches.values()].flat());

  // --- verdicts -----------------------------------------------------------
  const problems = [];

  const deadProbes = results.filter((r) => !r.ok);
  for (const r of deadProbes) {
    problems.push(`DEAD PROBE: ${r.name} [${r.ciStep}]\n  ${r.error}`);
  }

  const staleEntries = [...allowMatches.entries()].filter(([, m]) => m.length === 0);
  for (const [entry] of staleEntries) {
    problems.push(
      `STALE ALLOW-LIST ENTRY: ${entry.pattern} matches no tracked test file.\n` +
        `  reason on record: ${entry.reason}\n` +
        '  Remove the entry — an exemption for a file that no longer exists hides the next one.'
    );
  }

  // A probe that did not report contributes NOTHING to COVERED, so every file
  // it would have selected is arithmetically identical to a file no config
  // selects. Printing that list as ORPHANED states a measurement that was not
  // made — and the list is mostly, sometimes entirely, that dead probe's own
  // files. The count still gets reported (the discrepancy is real, and hiding
  // it would be its own silent skip); the FILE LIST does not, because naming
  // files is what makes it read as a finding someone should act on.
  const orphans = expected.filter((f) => !covered.has(f) && !allowed.has(f));
  if (orphans.length > 0 && deadProbes.length > 0) {
    problems.push(
      `ORPHAN REPORT SUPPRESSED — ${orphans.length} tracked test file(s) are unaccounted for,\n` +
        `  but ${deadProbes.length} probe(s) above are DEAD, so this is not a measurement and the\n` +
        '  files are not listed. Most or all of them are likely selected by the dead probe(s).\n' +
        '  Fix the probe, then re-run: the orphan list is only meaningful once every probe reports.'
    );
  } else if (orphans.length > 0) {
    problems.push(
      `ORPHANED TEST FILES (${orphans.length}) — tracked, but run by NO CI test config:\n` +
        orphans.map((f) => `  - ${f}`).join('\n') +
        '\n\n  Fix by ONE of:\n' +
        '    - add the file to a CI config\'s testMatch (and keep the local list converged);\n' +
        '    - add a CI job that runs it;\n' +
        '    - add an ALLOW_LIST entry in this file, with a reason and a filed backlog item;\n' +
        '    - delete the file.\n' +
        '  Do NOT widen a coverage glob just to quiet this.'
    );
  }

  const accounted = expected.filter((f) => covered.has(f)).length;
  console.log(
    `Summary: ${accounted} covered by a CI config, ${allowed.size} allow-listed, ` +
      `${orphans.length} ${deadProbes.length > 0 ? 'unaccounted (NOT measurable — a probe is dead)' : 'orphaned'}.`
  );
  console.log('');

  if (problems.length > 0) {
    console.error('='.repeat(78));
    console.error(`TEST-DRIFT GATE FAILED (${problems.length} problem(s))`);
    console.error('='.repeat(78));
    for (const p of problems) console.error('\n' + p);
    console.error('');
    process.exit(EXIT_PROBLEM);
  }

  console.log('TEST-DRIFT GATE PASSED — every tracked test file is run by a CI config or explicitly allow-listed.');
}

main();
