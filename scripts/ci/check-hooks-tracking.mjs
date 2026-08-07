#!/usr/bin/env node
/**
 * check-hooks-tracking — BACKLOG-2577 standing rule
 *
 * Asserts two things about how git hooks are stored:
 *
 *   1. NOTHING under `.husky/_` is tracked.
 *   2. `.husky/pre-push` and `.husky/pre-commit` ARE tracked.
 *
 * Why rule 1 is the important one. `.husky/_` is husky's generated runner
 * directory, and `core.hooksPath` points into it. Tracking a file makes its
 * presence a function of the checked-out branch — measured:
 *
 *     .husky/_ UNTRACKED, 3 branch switches      -> [h pre-push]  SURVIVED
 *     .husky/_ tracked, checkout a branch w/o it -> []            DIRECTORY REMOVED
 *
 * With an absolute `core.hooksPath` (the state this repo has had), that deleted
 * directory silently disables pre-push AND pre-commit in the main checkout and
 * in every worktree that points at it — exit 0, no warning. An ordinary
 * `git checkout` would do it.
 *
 * Hook infrastructure requires branch-independence, and tracking is definitionally
 * branch-dependence. That is why this check is inverted from the usual "make sure
 * the file is committed" shape.
 *
 * Bootstrapping a worktree's `.husky/_` is `npm run hooks:doctor -- --seed`,
 * which copies the files in UNTRACKED.
 *
 * This script only inspects the git index. It never invokes husky's installer —
 * doing so in CI would write `core.hooksPath` as a side effect.
 *
 * @module scripts/ci/check-hooks-tracking
 */

import { execFileSync } from "node:child_process";

const REQUIRED_TRACKED = [".husky/pre-push", ".husky/pre-commit"];

function gitLines(args) {
  return execFileSync("git", args, { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

const failures = [];

// Rule 1 — nothing under .husky/_ may be tracked.
const trackedRunner = gitLines(["ls-files", ".husky/_"]);
if (trackedRunner.length > 0) {
  failures.push(
    `${trackedRunner.length} file(s) under .husky/_ are TRACKED:\n` +
      trackedRunner.map((f) => `      ${f}`).join("\n") +
      "\n\n" +
      "    Tracking these makes hook presence branch-dependent: checking out a branch\n" +
      "    without them DELETES .husky/_, and with an absolute core.hooksPath that\n" +
      "    silently disables pre-push and pre-commit repo-wide (exit 0, no warning).\n" +
      "    Hook infrastructure requires branch-independence; tracking is definitionally\n" +
      "    branch-dependence.\n\n" +
      "    Fix:  git rm --cached -r .husky/_\n" +
      "    To give a worktree its runner directory:  npm run hooks:doctor -- --seed"
  );
}

// Rule 2 — the user hooks themselves must be tracked (they are the shared policy).
const trackedHooks = new Set(gitLines(["ls-files", ".husky"]));
for (const hook of REQUIRED_TRACKED) {
  if (!trackedHooks.has(hook)) {
    failures.push(
      `${hook} is NOT tracked. The user hooks are shared policy and must be in version control.\n` +
        `    Fix:  git add ${hook}`
    );
  }
}

if (failures.length > 0) {
  console.error("\nhooks tracking check FAILED (BACKLOG-2577):\n");
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log("hooks tracking check passed:");
console.log("  - nothing under .husky/_ is tracked (branch-independent)");
console.log(`  - tracked user hooks: ${REQUIRED_TRACKED.join(", ")}`);
