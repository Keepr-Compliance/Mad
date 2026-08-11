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
 * The two columns can disagree, and the message says which one is at fault. The
 * case that matters is `i/-text w/lf`: the STAGED blob carries the bytes while
 * the file on disk is already clean. That is a developer who fixed the file and
 * staged the wrong version, and it is the state that would actually reach a
 * commit — so the offsets are read out of the index blob, not off disk.
 *
 * An earlier draft reported that state as a `.gitattributes` rule and would have
 * sent someone hunting for a rule that does not exist. Provoking the branch is
 * what exposed it, and testing the claim is what settled it: `-text`, `binary`
 * and `-text -diff` were each set on a clean file and all three left the eol
 * columns at `i/lf w/lf`, moving only the attr column. Git derives those columns
 * from blob content, so an attribute cannot cause this failure at all.
 *
 * @module scripts/ci/check-text-sources
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATHSPECS = ["electron/*.ts", "electron/*.tsx", "src/*.ts", "src/*.tsx"];

/** Bytes that make a file unreadable as text. Tab, LF and CR are excluded. */
function offendingBytes(buf) {
  const found = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) {
      let line = 1;
      for (let j = 0; j < i; j++) if (buf[j] === 0x0a) line++;
      found.push({ offset: i, byte: b, line });
    }
  }
  return found;
}

/** The bytes as they exist on disk. Null if the file is not in the worktree. */
function worktreeBytes(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** The bytes as STAGED — what a commit would actually carry. */
function indexBytes(path) {
  try {
    return execFileSync("git", ["cat-file", "blob", `:${path}`], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
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
  const [index, work] = row.slice(0, tab).trim().split(/\s+/);
  const path = row.slice(tab + 1);
  if (index === "i/-text" || work === "w/-text") {
    binary.push({ path, staged: index === "i/-text", onDisk: work === "w/-text" });
  }
}

const FIX =
  `      Fix: spell them as escapes. A control character wanted as fixture\n` +
  `      content belongs in the source as \\u0000 — same byte at runtime, and\n` +
  `      the file stays greppable. If it is a real NUL in a fixture, assert its\n` +
  `      char code is 0 so the escape is proven to produce the byte.\n` +
  `      Worked example: the BACKLOG-2637 comments in\n` +
  `      electron/services/folderExport/__tests__/threadContactLabel.test.ts\n`;

function listBytes(found) {
  const shown = found
    .slice(0, 10)
    .map(
      ({ offset, byte, line }) =>
        `        offset ${offset} (line ${line}): 0x` + byte.toString(16).padStart(2, "0"),
    )
    .join("\n");
  return (
    `      ${found.length} control byte(s):\n${shown}` +
    (found.length > 10 ? `\n        ...and ${found.length - 10} more` : "")
  );
}

if (binary.length > 0) {
  console.error("\ntext-source check FAILED (BACKLOG-2637):\n");
  for (const { path, staged, onDisk } of binary) {
    const header =
      `  - ${path}\n` +
      `      reads as BINARY, so every plain grep skips it silently — a repo-wide\n` +
      `      search for anything in this file returns a clean-looking negative.\n\n`;

    const disk = onDisk ? offendingBytes(worktreeBytes(path) ?? Buffer.alloc(0)) : [];
    if (disk.length > 0) {
      console.error(header + listBytes(disk) + `\n\n` + FIX);
      continue;
    }

    // Staged binary, clean on disk: the fix exists in the working tree but the
    // blob heading for the commit is still the bad one. Report the INDEX bytes,
    // because those are what would actually land.
    const idx = staged ? offendingBytes(indexBytes(path) ?? Buffer.alloc(0)) : [];
    if (idx.length > 0) {
      console.error(
        header +
          `      The file ON DISK is clean — these bytes are in the STAGED blob, which\n` +
          `      is what a commit would carry. Stage the fixed file:  git add ${path}\n\n` +
          listBytes(idx) +
          `\n\n` +
          FIX,
      );
      continue;
    }

    // Fallback. Not reachable by any route found while writing this: git derives
    // the eol columns from blob CONTENT, and no .gitattributes setting moves them
    // (`-text`, `binary` and `-text -diff` were each tried against a clean file
    // and all three left `i/lf w/lf`, changing only the attr column). It exists
    // so a flagged file can never produce an empty report — e.g. an unreadable
    // worktree copy with no index blob to fall back on.
    console.error(
      `  - ${path}\n` +
        `      git calls this binary, but neither the staged blob nor the file on disk\n` +
        `      could be read for control bytes. Run:  file ${path}\n` +
        `      and check for a .gitattributes rule marking the path binary.\n`,
    );
  }
  process.exit(1);
}

console.log("text-source check passed:");
console.log(`  - ${rows.length} tracked .ts/.tsx under electron/ and src/ read as text`);
console.log("  - none would be silently skipped by a repo-wide grep");
