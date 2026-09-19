#!/usr/bin/env node
/**
 * audit-guard — BACKLOG-3101
 *
 * Decides whether a failed `npm audit --audit-level=critical` in the `security`
 * CI job is a real finding or the npm registry having a bad day.
 *
 *     OUT=$(npm audit --audit-level=critical 2>&1); CODE=$?
 *     printf '%s\n' "$OUT" | node scripts/ci/audit-guard.mjs --npm-exit-code "$CODE"
 *
 * ## Why this exists as a file instead of an inline `run:` block
 *
 * The decision it makes is the whole point of the step, and an inline block
 * cannot be fed a canned transcript — so the previous version of this logic was
 * never tested, and shipped a condition that did not cover the failure it was
 * written for. As a script it takes its two inputs (npm's combined output, npm's
 * exit code) as arguments, which makes every case above a two-line test.
 * See scripts/__tests__/auditGuard.test.ts.
 *
 * ## Why the condition is npm's own line and not a list of HTTP codes
 *
 * BACKLOG-2265 tolerated a fixed grep list built from the failures visible that
 * day: `endpoint is being retired`, `400 Bad Request`, and the connection-level
 * errors (ECONNRESET / ETIMEDOUT / …). On 2026-09-04 the registry answered 503
 * three times. A 5xx is the registry replying, so no connection error fired, and
 * it is not a 400 — the list matched nothing and a REQUIRED check went red with
 * no advisory involved. The list enumerated instances of a class.
 *
 * npm prints exactly one line for every failure of that class, whatever the
 * transport or status code:
 *
 *     npm error audit endpoint returned an error
 *
 * Both real transcripts in scripts/__tests__/fixtures/audit-guard/ contain it —
 * the 2026-09-04 503 and the 2026-07-26 400 that BACKLOG-2265 was filed for.
 * A successful audit never prints it: npm writes the advisory report to stdout
 * with no `npm error` prefix at all (verified against a real critical-advisory
 * fixture). So one condition replaces the list, and the list stops growing.
 *
 * ## What still fails
 *
 * A real critical advisory. npm exits non-zero having produced a report, that
 * report does not contain the marker, and this script forwards the exit code
 * unchanged. That is the case the tolerance must not swallow, and it is the case
 * scripts/__tests__/auditGuard.test.ts exists to pin.
 *
 * Runs in the `security` job, which does checkout + setup-node and NO `npm ci`.
 * Node stdlib only.
 *
 * @module scripts/ci/audit-guard
 */

/**
 * npm's marker for "the audit endpoint did not give me a usable answer".
 * Matched case-sensitively and as an exact substring: this is a literal string
 * npm emits, not a pattern, and widening it is how a tolerance starts swallowing
 * real failures.
 */
const INFRA_MARKER = "audit endpoint returned an error";

/**
 * Pure decision. Exported for tests; the CLI below is a thin wrapper.
 *
 * @param {string} output   npm's combined stdout+stderr
 * @param {number} npmExit  npm's exit code
 * @returns {{ exitCode: number, warning: string | null }}
 */
export function decideAuditOutcome(output, npmExit) {
  if (npmExit === 0) {
    return { exitCode: 0, warning: null };
  }
  if (output.includes(INFRA_MARKER)) {
    return {
      exitCode: 0,
      warning:
        "npm audit could not reach a usable audit endpoint " +
        `("${INFRA_MARKER}") — treating as non-fatal (BACKLOG-3101). ` +
        "A real critical advisory still fails this step.",
    };
  }
  return { exitCode: npmExit, warning: null };
}

/** Reads all of stdin as UTF-8. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseNpmExitCode(argv) {
  const i = argv.indexOf("--npm-exit-code");
  if (i === -1 || i === argv.length - 1) return null;
  const raw = argv[i + 1];
  if (!/^-?\d+$/.test(raw)) return null;
  return Number(raw);
}

async function main() {
  // Fail closed. A guard that exits 0 when it was invoked wrongly is a hole in
  // the required check, not a convenience.
  const npmExit = parseNpmExitCode(process.argv.slice(2));
  if (npmExit === null) {
    console.error(
      "audit-guard: usage: <npm audit output on stdin> | audit-guard.mjs --npm-exit-code <integer>"
    );
    process.exit(1);
  }

  const { exitCode, warning } = decideAuditOutcome(await readStdin(), npmExit);
  // ::warning:: is parsed from stdout by the Actions runner, not stderr.
  if (warning) console.log(`::warning::${warning}`);
  process.exit(exitCode);
}

// Only run the CLI when executed directly, so the module stays importable.
if (process.argv[1] && process.argv[1].endsWith("audit-guard.mjs")) {
  main();
}
