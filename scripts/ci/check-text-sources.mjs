#!/usr/bin/env node
/**
 * check-text-sources — BACKLOG-2637 standing rule
 *
 * Asserts that every tracked TypeScript/JavaScript file in the repository can
 * actually be found by a search.
 *
 * ## The failure this exists to prevent
 *
 * A source file containing a raw NUL byte is classified as binary by the search
 * tools, which then omit it from every repo-wide sweep. They do not warn, do not
 * print "binary file matches" when asked for a filename list, and do not exit
 * non-zero. They silently leave it out. Measured on the file this rule was
 * written for:
 *
 *     $ grep -rn 'defuses every reserved Windows DEVICE name' electron/
 *     (no output, exit 1)      <- the string was on line 259 of that file
 *
 * So the failure mode is not a slow search or a failed one. It is a repo-wide
 * search returning a CLEAN-LOOKING NEGATIVE, which is the most expensive shape
 * of wrong answer available: every sweep silently excludes the file and nothing
 * anywhere says so. It happened twice in one epic (`contactManualLink.ts`, then
 * `threadContactLabel.test.ts`) and both times a person found it by running
 * `file` on a hunch, not by any check.
 *
 * The repository's own PII scanner had the identical blind spot for the identical
 * reason — `check-fixture-pii.mjs` skips any file containing a NUL — so the file
 * that triggered this rule had never been scanned for personal data in its life.
 *
 * A NUL is almost never intentional in TypeScript. When it IS wanted — a fixture
 * exercising control-character handling — it belongs in the source as an escape
 * (backslash-u-0000), which produces the same byte at runtime while leaving the
 * file searchable. That is the fix this rule enforces; the worked example is in
 * electron/services/folderExport/__tests__/threadContactLabel.test.ts, where the
 * fixture asserts its own char code is 0 so the escape is proven to produce the
 * byte rather than the literal text.
 *
 * ## What actually makes a file unsearchable — measured, not assumed
 *
 * Every row below was produced by planting the byte in a scratch file in a real
 * git repository and running each tool.
 *
 * "agent grep" is specific and worth naming exactly: inside the AI coding agent
 * used on this repository, `grep` is a shell function installed by the tool's
 * shell snapshot that runs `ugrep -I`. `-I` means skip binary, silently. It is
 * NOT the `grep` a human gets at an interactive prompt — that is /usr/bin/grep,
 * which announces `Binary file X matches`. So the same command typed by a person
 * and run by an agent disagree about whether the file exists, and only the agent
 * is misled. This distinction was itself a measurement: a first run of the
 * control battery reported these files as findable because the script was
 * executed with `bash`, where the zsh-installed function does not exist and
 * /usr/bin/grep answered instead.
 *
 *   needle                          git --eol  file(1)  agent grep  rg   BSD grep
 *   NUL @ offset 25 (small file)     -text      data     SKIPPED   skips announces
 *   NUL @ 9,000 (20 KB file)         -text      data     SKIPPED   skips announces
 *   NUL @ 150,000 (200 KB file)      -text      TEXT     SKIPPED   reads announces
 *   NUL @ 1,500,000 (2 MB file)      -text      TEXT     reads     reads reads
 *   invalid UTF-8 (0xFF), any depth    lf       text     SKIPPED   reads reads
 *   lone CR (0x0D, no LF)            -text      text     reads     reads reads
 *   ESC (0x1B), e.g. colour codes      lf       text     reads     reads reads
 *
 * Four things follow, and they are the whole design:
 *
 *   1. `file(1)` is NOT a reliable detector. It reads a prefix, so it called a
 *      200 KB file with a NUL at offset 150,000 "ASCII text" while that file was
 *      silently unsearchable. A `file`-based sweep — the obvious implementation —
 *      has a false negative built into it.
 *   2. Git caught the NUL at every depth and size tried. It is the better signal,
 *      but this script does not depend on that holding: the read pass below is
 *      authoritative and depth-independent, and git is used for enumeration and
 *      for the staged-blob case only.
 *   3. Invalid UTF-8 is silently skipped by the agent shell's own grep and is
 *      invisible to git. Only decoding catches it, which is why this script runs
 *      a strict decode over every file. Cost: 53 ms across 22 MB / 2,121 files.
 *   4. ESC and other C0 bytes make no tool skip anything. They are reported as
 *      context when a file fails for another reason and are NEVER a failure on
 *      their own — `scripts/hooks-doctor.mjs` legitimately carries 9 of them in
 *      terminal colour sequences, and `public/pdf.worker.min.mjs` more.
 *
 * A lone CR is enforced but carries no search claim: git calls such a file binary
 * (its `lonecr` rule), which degrades diff and merge, but every search tool still
 * reads it.
 *
 * ## Scope
 *
 * Repository-wide, every tracked TS/JS extension. The narrow original scope
 * (`electron/` and `src/`) left 691 of 2,051 tracked .ts/.tsx files unchecked —
 * a third of the TypeScript, including admin-portal, broker-portal,
 * android-companion, e2e, packages, supabase and scripts. A green badge that
 * covers two thirds of the code says nothing about the other third, and the
 * clinching case is this script: it acquired the defect during its own
 * development, and it lives in `scripts/`, outside the narrow net.
 *
 * There are no exclusions. `public/pdf.worker.min.mjs` — a 1 MB vendored,
 * minified bundle — is in scope and passes: valid UTF-8, no NUL, and searchable.
 * An exclusion that trips nothing today would be untested code, so if a
 * re-vendored bundle ever fails this check that is a decision to make in review,
 * not one to pre-empt here.
 *
 * ## This script is not exempt from its own rule
 *
 * It did not start out passing. The paragraph above originally quoted a NUL
 * inline to illustrate the fix, and the byte came along: `file` called this
 * script binary data on its first save. The same paste hazard rejected two SQL
 * statements from Postgres with `invalid message format` and contaminated the
 * first draft of the pull request description. Copying the character is how it
 * spreads — it survives a paste through an editor, a terminal, a database client
 * and a commit without ever being visible. That is recorded here rather than
 * quietly cleaned up, because it is the whole argument for the rule.
 *
 * @module scripts/ci/check-text-sources
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATHSPECS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];

const NUL = "nul";
const BAD_UTF8 = "bad-utf8";
const LONE_CR = "lone-cr";

function gitZ(args) {
  return execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function lineAt(buf, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (buf[i] === 0x0a) line++;
  return line;
}

/**
 * Everything wrong with these bytes. Authoritative and depth-independent: it
 * reads the whole buffer rather than a prefix, which is where `file(1)` fails.
 */
function inspect(buf) {
  const faults = new Set();
  const sites = [];
  const context = [];

  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x09 || b === 0x0a) continue;
    if (b === 0x0d) {
      if (buf[i + 1] !== 0x0a) {
        faults.add(LONE_CR);
        sites.push({ offset: i, byte: b, line: lineAt(buf, i) });
      }
      continue;
    }
    if (b === 0x00) {
      faults.add(NUL);
      sites.push({ offset: i, byte: b, line: lineAt(buf, i) });
    } else if (b < 0x20 || b === 0x7f) {
      // Context only. Nothing skips a file for these.
      context.push({ offset: i, byte: b, line: lineAt(buf, i) });
    }
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    faults.add(BAD_UTF8);
  }

  return { faults, sites, context };
}

function listSites(sites, limit = 10) {
  const shown = sites
    .slice(0, limit)
    .map(
      ({ offset, byte, line }) =>
        `        offset ${offset} (line ${line}): 0x` + byte.toString(16).padStart(2, "0"),
    )
    .join("\n");
  return shown + (sites.length > limit ? `\n        ...and ${sites.length - limit} more` : "");
}

const FIX_ESCAPE =
  `      Fix: spell it as an escape. A control character wanted as fixture content\n` +
  `      belongs in the source as \\u0000 — the same byte at runtime, and the file\n` +
  `      stays searchable. Assert its char code is 0 so the escape is proven to\n` +
  `      produce the byte rather than the literal text. Worked example:\n` +
  `      electron/services/folderExport/__tests__/threadContactLabel.test.ts\n`;

// ---------------------------------------------------------------------------

const tracked = gitZ(["ls-files", "-z", "--", ...PATHSPECS]);
const failures = [];

for (const path of tracked) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    continue; // tracked but not in the worktree; the staged pass below covers it
  }
  const { faults, sites, context } = inspect(buf);
  if (faults.size > 0) failures.push({ path, faults, sites, context });
}

// Separate pass for one state the worktree cannot show: the STAGED blob is
// binary while the file on disk is already clean. That is a developer who fixed
// the file and staged the wrong version, and it is what a commit would carry.
const clean = new Set(failures.map((f) => f.path));
const stagedOnly = [];
for (const row of execFileSync("git", ["ls-files", "--eol", "--", ...PATHSPECS], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter(Boolean)) {
  const tab = row.indexOf("\t");
  if (tab === -1) continue;
  const [index] = row.slice(0, tab).trim().split(/\s+/);
  const path = row.slice(tab + 1);
  if (index !== "i/-text" || clean.has(path)) continue;
  let blob;
  try {
    blob = execFileSync("git", ["cat-file", "blob", `:${path}`], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    continue;
  }
  const { faults, sites } = inspect(blob);
  if (faults.size > 0) stagedOnly.push({ path, sites });
}

if (failures.length > 0 || stagedOnly.length > 0) {
  console.error("\ntext-source check FAILED (BACKLOG-2637):\n");

  for (const { path, faults, sites, context } of failures) {
    let why;
    if (faults.has(NUL)) {
      why =
        `      This file holds a NUL, so the search tools classify it as binary and\n` +
        `      omit it — silently, with no warning and no non-zero exit. A repo-wide\n` +
        `      search for anything in this file returns a clean-looking negative.\n`;
    } else if (faults.has(BAD_UTF8)) {
      why =
        `      This file is not valid UTF-8. The agent shell's grep (ugrep -I) skips it\n` +
        `      silently. ripgrep and /usr/bin/grep still read it, so the file looks\n` +
        `      findable when a person checks and vanishes when an agent sweeps.\n`;
    } else {
      why =
        `      This file holds a lone CR (0x0D with no LF). Git calls that binary via\n` +
        `      its lonecr rule, which degrades diff and merge. Search tools DO read it\n` +
        `      — this is not the grep failure, but it is not a line ending we use.\n`;
    }

    let body = `  - ${path}\n${why}`;
    if (sites.length > 0) {
      body += `\n      ${sites.length} offending byte(s):\n${listSites(sites)}\n`;
    }
    if (faults.has(BAD_UTF8) && sites.length === 0) {
      body += `\n      (no control byte — the fault is a byte sequence that is not UTF-8)\n`;
    }
    if (context.length > 0) {
      body +=
        `\n      For context, ${context.length} other C0 byte(s) are present. Those alone\n` +
        `      make no tool skip a file and are not why this failed.\n`;
    }
    body += faults.has(LONE_CR) && !faults.has(NUL) ? "" : `\n${FIX_ESCAPE}`;
    console.error(body);
  }

  for (const { path, sites } of stagedOnly) {
    console.error(
      `  - ${path}\n` +
        `      The file ON DISK is clean — these bytes are in the STAGED blob, which is\n` +
        `      what a commit would carry. Stage the fixed file:  git add ${path}\n\n` +
        `      ${sites.length} offending byte(s):\n${listSites(sites)}\n\n` +
        FIX_ESCAPE,
    );
  }

  process.exit(1);
}

console.log("text-source check passed:");
console.log(`  - ${tracked.length} tracked TS/JS files, repository-wide, are searchable`);
console.log("  - no NUL, no invalid UTF-8, no lone CR; none would be silently skipped");
