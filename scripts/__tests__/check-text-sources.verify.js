#!/usr/bin/env node
/**
 * VERIFICATION HARNESS for scripts/ci/check-text-sources.mjs — BACKLOG-3065
 * =============================================================================
 * A verification harness that never executes is indistinguishable from one that
 * passes. Run it with `npm run verify:text-sources`.
 *
 * NOTE (BACKLOG-3137): no CI job runs this yet. The "Verify the guard itself"
 * step for the `text-sources` job was deferred out of BACKLOG-3065 because
 * feature/BACKLOG-3133-message-hygiene (PR #2527) is restructuring ci.yml by
 * +160/-8, and a step added into a job being reshaped can merge cleanly and
 * still land in the wrong place. Until 3137 lands this harness is runnable but
 * unexecuted by CI — precisely the state the first sentence warns about, so it
 * is recorded here rather than left to be discovered.
 *
 * ## What the gate got wrong, and what these controls pin
 *
 * The enumeration read the INDEX (`git ls-files -z`) while the inspection read
 * WORKTREE bytes. A file not yet `git add`-ed was invisible, so a brand-new
 * source file holding a raw NUL — the `contactManualLink.ts` shape, and the
 * whole reason the gate exists — passed silently, under the printed claim that
 * "none would be silently skipped".
 *
 * ## Why these controls exercise the shipped code path
 *
 * The gate takes no arguments: it passes no `cwd:` to git and reads relative
 * paths, so both inherit `process.cwd()`. Spawning it with `cwd: <fixture>`
 * therefore runs the REAL script, not a re-implementation of it. (The sibling
 * check-sql-boundary.mjs needed a `--root` flag to reach the same place.)
 *
 * Every fixture is a throwaway `git init` tree under the OS temp dir, so no
 * `git add` here ever touches this repository's index. Nothing is committed:
 * `--cached` reads the index, so staging is enough, and a commit would need
 * user identity configured — a CI flake source.
 *
 * `core.excludesFile` is pinned to an empty file because `--exclude-standard`
 * honours the user's GLOBAL gitignore, and a developer's personal ignore rules
 * must not decide what these controls enumerate.
 *
 * ## Controls
 *   T1   a raw NUL in an UNTRACKED file            -> RED, names the file
 *   T2   the same file staged                      -> byte-identical finding
 *   T3a  the same file gitignored                  -> GREEN, and counted out
 *   T3b  the ignore rule removed, nothing else     -> RED
 *   T4   staged blob binary, worktree clean        -> RED via the --eol pass
 *   T5   legitimate files only                     -> GREEN
 *   T6   unmerged index lists a path twice         -> 3 raw entries, 2 reported
 *
 * T3b matters because without it "excluded" is indistinguishable from "cannot
 * see untracked files at all" — which was the bug. T4 is the regression risk of
 * the BACKLOG-3065 change and the control most likely to be skipped.
 *
 * Two controls cannot live here and are recorded in the PR body instead: the
 * base script going GREEN on T1's tree (this harness only ever runs the fixed
 * script), and the T4 break (flipping the --eol pass's own decision to prove
 * that T4 is able to fail).
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const GATE = path.join(REPO_ROOT, "scripts", "ci", "check-text-sources.mjs");

// Spelled as an escape, never pasted. This harness is itself a .js file under
// scripts/ and so falls in the gate's own scope: a literal NUL here would make
// the harness unsearchable and trip the very check it verifies. The assertion
// proves the escape produced the byte rather than the six literal characters —
// the same proof the gate's own advice asks for.
const NUL = "\u0000";
if (NUL.charCodeAt(0) !== 0) throw new Error("NUL escape did not produce byte 0");

const CLEAN_SRC = "export const ok = 1;\n";
const NUL_SRC = `export const bad = "a${NUL}b";\n`;
const EMPTY_EXCLUDES = ".textsrc-empty-excludes";

const results = [];
const record = (id, name, ok, detail) => results.push({ id, name, ok, detail });

const git = (dir, ...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });

function runGate(dir) {
  const r = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: "utf8" });
  return {
    code: r.status,
    out: r.stdout || "",
    err: r.stderr || "",
    all: (r.stdout || "") + (r.stderr || ""),
  };
}

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** A fixture tree that is its own git repository. */
function mkGitTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "textsrc-verify-"));
  write(dir, { ...files, [EMPTY_EXCLUDES]: "" });
  const init = git(dir, "init", "-q");
  if (init.status !== 0) {
    return { dir, ok: false, why: `git init failed: ${(init.stderr || "").trim()}` };
  }
  git(dir, "config", "core.excludesFile", path.join(dir, EMPTY_EXCLUDES));
  return { dir, ok: true, why: "" };
}

const gitAdd = (dir, ...rels) => git(dir, "add", "--", ...rels).status === 0;

/**
 * The file count the gate prints on success, or null if it printed none.
 *
 * Deliberately tolerant of the words between the number and "TS/JS files": the
 * count is the subject here, not the phrasing. A wording-coupled matcher made
 * T3a, T5 and T6 fail with `count=null` when this harness was first run against
 * the pre-fix script — hiding the real signal (T6's count of 3) behind an
 * artefact of the message text.
 */
function passedCount(out) {
  const m = out.match(/- (\d+)[^\n]*?TS\/JS files/);
  return m ? Number(m[1]) : null;
}

/** Drop a fixture tree only when its controls passed, so a failure stays open. */
function cleanupIfPassed(dir, n) {
  if (results.slice(-n).every((r) => r.ok)) fs.rmSync(dir, { recursive: true, force: true });
}

const FAILED_BANNER = "text-source check FAILED (BACKLOG-2637):";
const NUL_REASON = "This file holds a NUL";
const ON_DISK_CLEAN = "The file ON DISK is clean";

// ---------------------------------------------------------------------------
// T1 / T2 — an untracked NUL file is seen, and staging it changes nothing.
// ---------------------------------------------------------------------------
{
  const { dir, ok, why } = mkGitTree({ "src/clean.ts": CLEAN_SRC });
  if (!ok || !gitAdd(dir, "src/clean.ts")) {
    record("T1", "a raw NUL in an UNTRACKED file is RED", false, why || "git add failed");
    record("T2", "the same file, staged, gives a byte-identical finding", false, "T1 setup failed");
  } else {
    write(dir, { "src/newfile.ts": NUL_SRC });
    const untracked = runGate(dir);

    record(
      "T1",
      "a raw NUL in an UNTRACKED file is RED",
      untracked.code === 1 &&
        untracked.all.includes(FAILED_BANNER) &&
        untracked.all.includes("- src/newfile.ts") &&
        untracked.all.includes(NUL_REASON),
      `exit=${untracked.code} banner=${untracked.all.includes(FAILED_BANNER)} ` +
        `named=${untracked.all.includes("- src/newfile.ts")} ` +
        `nul=${untracked.all.includes(NUL_REASON)}`,
    );

    // Staging must produce the SAME finding, not the staged-blob one: the file
    // is already reported from disk, and `alreadyReported` suppresses the --eol
    // branch for it. "Same finding" is asserted as byte equality — a weaker
    // assertion would pass on two materially different messages.
    const staged = gitAdd(dir, "src/newfile.ts") ? runGate(dir) : null;
    record(
      "T2",
      "the same file, staged, gives a byte-identical finding",
      Boolean(staged) &&
        staged.code === 1 &&
        staged.all === untracked.all &&
        !staged.all.includes(ON_DISK_CLEAN),
      staged
        ? `exit=${staged.code} identical=${staged.all === untracked.all} ` +
            `staged-block-absent=${!staged.all.includes(ON_DISK_CLEAN)}`
        : "git add failed",
    );
    cleanupIfPassed(dir, 2);
  }
}

// ---------------------------------------------------------------------------
// T3a / T3b — gitignored stays out; remove ONLY the ignore rule and it is RED.
//
// Without T3b, "excluded because ignored" is indistinguishable from "never
// enumerated because untracked" — and the second was the defect.
// ---------------------------------------------------------------------------
{
  const { dir, ok, why } = mkGitTree({
    "src/clean.ts": CLEAN_SRC,
    ".gitignore": "src/ignored.ts\n",
  });
  if (!ok || !gitAdd(dir, "src/clean.ts")) {
    record("T3a", "a gitignored NUL file is NOT enumerated", false, why || "git add failed");
    record("T3b", "removing only the ignore rule turns it RED", false, "T3a setup failed");
  } else {
    write(dir, { "src/ignored.ts": NUL_SRC });
    const ignored = runGate(dir);
    record(
      "T3a",
      "a gitignored NUL file is NOT enumerated",
      ignored.code === 0 && passedCount(ignored.out) === 1,
      `exit=${ignored.code} count=${passedCount(ignored.out)} (expected 0 / 1)`,
    );

    fs.rmSync(path.join(dir, ".gitignore"));
    const unignored = runGate(dir);
    record(
      "T3b",
      "removing only the ignore rule turns it RED",
      unignored.code === 1 &&
        unignored.all.includes("- src/ignored.ts") &&
        unignored.all.includes(NUL_REASON),
      `exit=${unignored.code} named=${unignored.all.includes("- src/ignored.ts")}`,
    );
    cleanupIfPassed(dir, 2);
  }
}

// ---------------------------------------------------------------------------
// T4 — the --eol pass still catches a binary STAGED blob under a clean worktree.
//
// This is the regression risk of BACKLOG-3065: that pass is index-based BY
// DESIGN and was deliberately left without --others. No commit is needed —
// `ls-files --eol` and `cat-file blob :path` both read the index.
// ---------------------------------------------------------------------------
{
  const { dir, ok, why } = mkGitTree({ "src/clean.ts": CLEAN_SRC });
  if (!ok || !gitAdd(dir, "src/clean.ts")) {
    record("T4", "staged blob binary + clean worktree is RED", false, why || "git add failed");
  } else {
    write(dir, { "src/staged.ts": NUL_SRC });
    const stagedOk = gitAdd(dir, "src/staged.ts");
    write(dir, { "src/staged.ts": CLEAN_SRC }); // author fixed the file, staged the old one
    const r = stagedOk ? runGate(dir) : null;
    record(
      "T4",
      "staged blob binary + clean worktree is RED",
      Boolean(r) &&
        r.code === 1 &&
        r.all.includes(ON_DISK_CLEAN) &&
        r.all.includes("git add src/staged.ts"),
      r
        ? `exit=${r.code} on-disk-clean=${r.all.includes(ON_DISK_CLEAN)} ` +
            `remedy=${r.all.includes("git add src/staged.ts")}`
        : "git add failed",
    );
    cleanupIfPassed(dir, 1);
  }
}

// ---------------------------------------------------------------------------
// T5 — a legitimate tree stays GREEN. Without this the suite could pass by
// reddening everything.
// ---------------------------------------------------------------------------
{
  const { dir, ok, why } = mkGitTree({ "src/clean.ts": CLEAN_SRC, "src/other.tsx": CLEAN_SRC });
  if (!ok || !gitAdd(dir, "src/clean.ts", "src/other.tsx")) {
    record("T5", "a legitimate tree stays GREEN", false, why || "git add failed");
  } else {
    const r = runGate(dir);
    record(
      "T5",
      "a legitimate tree stays GREEN",
      r.code === 0 && r.out.includes("text-source check passed:") && passedCount(r.out) === 2,
      `exit=${r.code} count=${passedCount(r.out)} (expected 0 / 2)`,
    );
    cleanupIfPassed(dir, 1);
  }
}

// ---------------------------------------------------------------------------
// T6 — the Set de-dupes an unmerged index. Not defensive tidiness: the count is
// PRINTED, so without the Set a developer resolving a merge conflict reads a
// file count that is wrong.
//
// The unmerged state is built with `hash-object -w` + `update-index
// --index-info` at stages 2 and 3, NOT with two branches and a real merge: no
// commits means no user.name/user.email, hence no CI flake.
//
// Both halves are asserted. The raw listing must hold 3 entries for 2 paths —
// otherwise a "2" from the gate would prove nothing, because there would have
// been nothing to de-duplicate.
// ---------------------------------------------------------------------------
{
  const REL = "src/conflict.ts";
  const { dir, ok, why } = mkGitTree({ "src/clean.ts": CLEAN_SRC, [REL]: CLEAN_SRC });
  const hashObject = (content) => {
    const r = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      encoding: "utf8",
      input: content,
    });
    return r.status === 0 ? r.stdout.trim() : null;
  };

  if (!ok || !gitAdd(dir, "src/clean.ts")) {
    record("T6", "an unmerged index is counted once, not per stage", false, why || "git add failed");
  } else {
    const ours = hashObject("export const ours = 1;\n");
    const theirs = hashObject("export const theirs = 2;\n");
    const applied =
      Boolean(ours) &&
      Boolean(theirs) &&
      spawnSync("git", ["update-index", "--index-info"], {
        cwd: dir,
        encoding: "utf8",
        input: `100644 ${ours} 2\t${REL}\n100644 ${theirs} 3\t${REL}\n`,
      }).status === 0;

    const raw = git(dir, "ls-files", "--cached").stdout.split("\n").filter(Boolean);
    const stages = raw.filter((p) => p === REL).length;
    const r = applied ? runGate(dir) : null;

    record(
      "T6",
      "an unmerged index is counted once, not per stage",
      Boolean(r) && stages === 2 && raw.length === 3 && r.code === 0 && passedCount(r.out) === 2,
      `raw-entries=${raw.length} stages-of-${REL}=${stages} ` +
        `exit=${r ? r.code : "n/a"} reported=${r ? passedCount(r.out) : "n/a"} ` +
        `(expected 3 raw / 2 stages / exit 0 / 2 reported)`,
    );
    cleanupIfPassed(dir, 1);
  }
}

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log("\ncheck-text-sources verification (BACKLOG-3065)\n");
for (const { id, name, ok, detail } of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${name}`);
  if (!ok) console.log(`        ${detail}`);
}
console.log(`\n  ${results.length - failed.length}/${results.length} controls passed\n`);

if (failed.length > 0) {
  console.error(`verification FAILED: ${failed.map((f) => f.id).join(", ")}\n`);
  process.exit(1);
}
