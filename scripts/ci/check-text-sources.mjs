#!/usr/bin/env node
/**
 * check-text-sources — BACKLOG-2637 standing rule
 *
 * Asserts that every tracked `.ts`/`.tsx` under `electron/` and `src/` is TEXT.
 *
 * Why this is a CI job and not a code-review habit. A source file containing a
 * raw NUL byte is classified as binary by `file(1)`, by git, and — the part that
 * costs — by grep. Plain grep does not warn, does not print "binary file
 * matches" when asked for a filename list, and does not exit non-zero. It
 * silently omits the file. Measured on the file this rule was written for:
 *
 *     $ grep -rn 'defuses every reserved Windows DEVICE name' electron/
 *     (no output, exit 1)      <- the string was on line 259 of that file
 *
 * So the failure mode is not "a search is slow" or "a search errors". It is
 * "a repo-wide search returns a clean-looking negative", which is the single
 * most expensive shape of wrong answer available: every sweep over the codebase
 * silently excludes the file, and nothing anywhere says so. This happened twice
 * in the same epic — `contactManualLink.ts`, then this one — and both times it
 * was found by someone running `file` on a hunch, not by any check.
 *
 * This script is not exempt from its own rule, and did not start out passing it.
 * The paragraph below originally quoted a NUL inline to illustrate the fix, and
 * the byte came along: `file` called this script binary data on its first save.
 * Copying the character is how it spreads — it survives a paste through an
 * editor, a terminal and a commit without ever being visible. That is the whole
 * argument for the rule, so it is recorded here rather than quietly cleaned up.
 *
 * A NUL is almost never intentional in TypeScript. When it IS wanted — a fixture
 * exercising control-character handling — it belongs in the source as an escape
 * (backslash-u-0000), which produces the same byte at runtime while leaving
 * the file greppable. That is the fix this rule enforces; the worked example is
 * in electron/services/folderExport/__tests__/threadContactLabel.test.ts, where
 * the fixture asserts its own char code is 0 so the escape is proven to produce
 * the byte rather than the literal text.
 *
 * ## How it detects
 *
 * One `git ls-files --eol` invocation over the tracked set — 1360 files at the
 * time of writing, one process, no install step, no content grep. Git applies
 * the same NUL heuristic grep does and reports `-text` for a binary blob:
 *
 *     i/-text w/-text attr/   .../threadContactLabel.test.ts     <- offender
 *     i/lf    w/lf    attr/   .../threadContactLabel.ts          <- normal
 *
 * Both columns are checked. `i/` is the staged blob and `w/` the working tree,
 * so a file that is clean in the index but has had a NUL introduced on disk is
 * still caught.
 *
 * Only for a file that is already flagged does this script read bytes, and then
 * only to report the exact offsets. That keeps the common (passing) path to a
 * single git call, and makes a failure actionable rather than a bare filename.
 *
 * It also distinguishes the one legitimate reason git reports `-text` without a
 * NUL present: a `.gitattributes` rule marking the path binary. That is a
 * deliberate configuration choice, not this defect, so it is reported as such
 * instead of being mislabelled.
 *
 * @module scripts/ci/check-text-sources
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATHSPECS = ["electron/*.ts", "electron/*.tsx", "src/*.ts", "src/*.tsx"];

/** Bytes that make a file unreadable as text. Tab, LF and CR are excluded. */
function offendingBytes(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return null; // deleted from the worktree; the index entry is still the truth
  }
  const found = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) found.push({ offset: i, byte: b });
  }
  return found;
}

function lineOf(path, offset) {
  const head = readFileSync(path).subarray(0, offset);
  let line = 1;
  for (const b of head) if (b === 0x0a) line++;
  return line;
}

// `git ls-files --eol` emits: i/<eol> w/<eol> attr/<text-attr> \t <path>
const rows = execFileSync("git", ["ls-files", "--eol", "--", ...PATHSPECS], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
})
  .split("\n")
  .filter(Boolean);

const binary = [];
for (const row of rows) {
  const tab = row.indexOf("\t");
  if (tab === -1) continue;
  const [index, work, attr] = row.slice(0, tab).trim().split(/\s+/);
  const path = row.slice(tab + 1);
  if (index === "i/-text" || work === "w/-text") {
    binary.push({ path, attr: attr ?? "attr/" });
  }
}

if (binary.length > 0) {
  console.error("\ntext-source check FAILED (BACKLOG-2637):\n");
  for (const { path, attr } of binary) {
    const found = offendingBytes(path);
    if (found && found.length > 0) {
      const shown = found
        .slice(0, 10)
        .map(
          ({ offset, byte }) =>
            `        offset ${offset} (line ${lineOf(path, offset)}): 0x` +
            byte.toString(16).padStart(2, "0"),
        )
        .join("\n");
      console.error(
        `  - ${path}\n` +
          `      reads as BINARY, so every plain grep skips it silently — a repo-wide\n` +
          `      search for anything in this file returns a clean-looking negative.\n\n` +
          `      ${found.length} control byte(s):\n${shown}` +
          (found.length > 10 ? `\n        ...and ${found.length - 10} more` : "") +
          `\n\n` +
          `      Fix: spell them as escapes. A control character wanted as fixture\n` +
          `      content belongs in the source as \\u0000 — same byte at runtime, and\n` +
          `      the file stays greppable. If it is a real NUL in a fixture, assert its\n` +
          `      char code is 0 so the escape is proven to produce the byte.\n` +
          `      Worked example: the BACKLOG-2637 comments in\n` +
          `      electron/services/folderExport/__tests__/threadContactLabel.test.ts\n`,
      );
    } else {
      console.error(
        `  - ${path}\n` +
          `      git reports it as binary (${attr}) but it holds no control bytes, so a\n` +
          `      .gitattributes rule is marking this path binary. Source under electron/\n` +
          `      and src/ must stay greppable — drop the rule or move the file.\n`,
      );
    }
  }
  process.exit(1);
}

console.log("text-source check passed:");
console.log(`  - ${rows.length} tracked .ts/.tsx under electron/ and src/ read as text`);
console.log("  - none would be silently skipped by a repo-wide grep");
