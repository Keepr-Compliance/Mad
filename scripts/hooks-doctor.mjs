#!/usr/bin/env node
/**
 * hooks-doctor — BACKLOG-2577
 *
 * Answers one question for the CURRENT worktree: "when I push, which hook runs,
 * and is it mine?"
 *
 * Why this exists. `.git/config` sets `core.hooksPath`, and that value is shared
 * by every worktree. While it is ABSOLUTE, all ~66 worktrees execute the MAIN
 * checkout's `.husky/pre-push`, whatever branch each has checked out. While it
 * is RELATIVE (`.husky/_`, which is what husky itself writes on every
 * `npm install`), each worktree runs its own — but a worktree with no
 * `.husky/_` directory runs NOTHING, and git reports that with silence and
 * exit 0. This script turns that silence into a non-zero exit.
 *
 * It is a DIAGNOSTIC. It reads git config and copies files; it never writes git
 * config. `npx husky` would rewrite the shared `core.hooksPath` as a side effect
 * of what should be a per-worktree file copy, which is why `--seed` exists here
 * instead.
 *
 *   node scripts/hooks-doctor.mjs           diagnose, exit non-zero if unprotected
 *   node scripts/hooks-doctor.mjs --seed    create this worktree's .husky/_, then diagnose
 *
 * @module scripts/hooks-doctor
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SEED = process.argv.includes("--seed");
const HOOKS = ["pre-push", "pre-commit"];
/** Files husky generates in `_` that a worktree needs in order to run any hook. */
const SEED_FILES = ["h", ".gitignore", ...HOOKS];

const bold = (s) => `[1m${s}[0m`;
const red = (s) => `[31m${s}[0m`;
const green = (s) => `[32m${s}[0m`;
const yellow = (s) => `[33m${s}[0m`;

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function md5(file) {
  try {
    return createHash("md5").update(fs.readFileSync(file)).digest("hex").slice(0, 8);
  } catch {
    return null;
  }
}

const problems = [];
const fail = (msg, detail) => problems.push({ msg, detail });

// ---------------------------------------------------------------------------
// Locate this worktree and the main checkout
// ---------------------------------------------------------------------------
const worktreeRoot = git(["rev-parse", "--show-toplevel"]);
if (!worktreeRoot) {
  console.error(red("hooks-doctor: not inside a git working tree."));
  process.exit(1);
}
// --git-common-dir points at the MAIN checkout's .git for every linked worktree.
const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
const mainRoot = commonDir ? path.dirname(commonDir) : worktreeRoot;
const isMain = path.resolve(mainRoot) === path.resolve(worktreeRoot);

// ---------------------------------------------------------------------------
// --seed: give this worktree its own .husky/_ by copying the main checkout's
// ---------------------------------------------------------------------------
if (SEED) {
  const from = path.join(mainRoot, ".husky", "_");
  const to = path.join(worktreeRoot, ".husky", "_");
  // A failed seed must still be loud — this is the ACTION failing, which is the
  // one thing --seed's exit code reports (see the exit-code contract below).
  if (!fs.existsSync(from)) {
    console.error(red(`hooks-doctor --seed: ${from} does not exist.`));
    console.error(`Run 'npm install' (or 'npx husky') in ${mainRoot} first — it regenerates .husky/_.`);
    process.exit(1);
  }
  fs.mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const f of SEED_FILES) {
    const src = path.join(from, f);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(to, f));
    if (f !== ".gitignore") fs.chmodSync(path.join(to, f), 0o755);
    copied += 1;
  }
  console.log(green(`seeded ${copied} file(s) into ${to}`));
  console.log(
    "These copies are deliberately UNTRACKED: hook infrastructure requires\n" +
      "branch-independence, and tracking is definitionally branch-dependence\n" +
      "(a checkout of a branch without them would delete the directory).\n"
  );
}

// ---------------------------------------------------------------------------
// Resolve what git + husky will actually execute
// ---------------------------------------------------------------------------
const hooksPath = git(["config", "--get", "core.hooksPath"]);
const scope = hooksPath ? git(["config", "--show-origin", "--get", "core.hooksPath"]).split("\t")[0] : "(unset)";

console.log(bold("\nhooks-doctor — BACKLOG-2577\n"));
console.log(`  worktree        ${worktreeRoot}${isMain ? "  (main checkout)" : ""}`);
console.log(`  branch          ${git(["rev-parse", "--abbrev-ref", "HEAD"]) || "(detached)"}`);
console.log(`  main checkout   ${mainRoot}`);
console.log(`  core.hooksPath  ${hooksPath || red("(unset — husky is not installed)")}   ${scope}`);

if (!hooksPath) {
  fail(
    "core.hooksPath is unset, so husky hooks do not run at all.",
    `Run 'npm install' in ${mainRoot}.`
  );
} else {
  const absolute = path.isAbsolute(hooksPath);
  const shimDir = absolute ? hooksPath : path.join(worktreeRoot, hooksPath);
  console.log(`  path style      ${absolute ? yellow("ABSOLUTE — shared by every worktree") : green("relative — resolves per worktree")}`);
  console.log("");

  for (const hook of HOOKS) {
    const shim = path.join(shimDir, hook);
    // husky's _/h resolves the user hook as dirname(dirname($0))/$(basename $0)
    const userHook = path.join(path.dirname(path.dirname(shim)), hook);
    const ownHook = path.join(worktreeRoot, ".husky", hook);

    const shimExists = fs.existsSync(shim);
    const userExists = fs.existsSync(userHook);
    const isOwn = path.resolve(userHook) === path.resolve(ownHook);

    console.log(bold(`  ${hook}`));
    console.log(`    resolves to   ${userHook}`);
    console.log(`    exists        ${userExists ? green("yes") : red("NO")}   md5 ${md5(userHook) ?? red("n/a")}`);
    console.log(`    this worktree ${ownHook}`);
    console.log(`                  ${fs.existsSync(ownHook) ? `md5 ${md5(ownHook)}` : red("ABSENT")}`);

    if (!shimExists) {
      console.log(`    verdict       ${red("NO HOOK WILL RUN — this is NOT a passing state")}`);
      fail(
        `${hook}: ${shimDir} has no '${hook}' shim, so git finds no hook and pushes proceed unchecked (exit 0, no warning).`,
        `Fix: npm run hooks:doctor -- --seed`
      );
    } else if (!userExists) {
      console.log(`    verdict       ${red("NO HOOK WILL RUN (husky exits 0 silently)")}`);
      fail(
        `${hook}: husky's _/h exits 0 when the user hook is missing, so this worktree is unprotected in silence.`,
        `This branch has no .husky/${hook}.`
      );
    } else if (!isOwn) {
      console.log(`    verdict       ${red("WRONG HOOK — running another checkout's file")}`);
      fail(
        `${hook}: resolves to ${userHook}, not this worktree's ${ownHook}.`,
        `This is BACKLOG-2577: core.hooksPath is absolute, so every worktree runs the main checkout's hook.`
      );
    } else {
      console.log(`    verdict       ${green("OK — this worktree's own hook")}`);
    }
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
if (problems.length === 0) {
  console.log(green(bold("PROTECTED — pushes from this worktree run this worktree's own hooks.\n")));
  process.exit(0);
}

console.log(red(bold(`UNPROTECTED — ${problems.length} problem(s):\n`)));
for (const { msg, detail } of problems) {
  console.log(`  - ${msg}`);
  if (detail) console.log(`    ${detail}`);
}
console.log(
  "\n" +
    yellow("A hookless worktree loses LOCAL FAST FEEDBACK, not correctness — CI\n") +
    yellow("remains the gate, so nothing bad merges because of this.\n")
);
if (!SEED) {
  console.log("Fix:\n\n  npm run hooks:doctor -- --seed\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Exit-code contract (--seed): the ACTION's result, not the diagnosis's.
//
// `npm run hooks:doctor -- --seed` is the MANDATORY step in the canonical
// worktree-creation snippet (CLAUDE.md, git-branching.md). Until core.hooksPath
// is switched to a relative path, WRONG HOOK is the CORRECT verdict for every
// worktree — so exiting non-zero here would fail that snippet every time, abort
// `set -e` flows, and train readers to ignore a non-zero exit from this script.
// That would destroy the exact signal the script exists to create.
//
// So: --seed reports whether the SEED worked. The bare `hooks:doctor` keeps
// strict semantics and is the diagnostic.
// ---------------------------------------------------------------------------
console.log(
  bold("--seed reports the SEED, not the diagnosis above — the copy succeeded, so this exits 0.\n") +
    "Until core.hooksPath becomes relative, WRONG HOOK is the correct verdict for\n" +
    "every worktree. For the strict check, run:\n\n  npm run hooks:doctor\n"
);
process.exit(0);
