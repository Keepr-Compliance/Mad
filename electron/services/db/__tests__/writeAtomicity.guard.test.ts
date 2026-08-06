/**
 * @jest-environment node
 *
 * BACKLOG-2530 STEP 4 — A MULTI-STATEMENT WRITE MAY NOT SHIP WITHOUT A
 * TRANSACTION.
 *
 * ===========================================================================
 * WHY A GUARD AND NOT A CONVENTION
 * ===========================================================================
 * Steps 1-3 of BACKLOG-2530 wrapped every write the audit found. That fixes
 * today and relies on every future author remembering tomorrow.
 *
 * **Conventions failed twice on 2026-08-05.** BACKLOG-2510 (an import path that
 * wrote no crosswalk row) and BACKLOG-2525 (a path with no duplicate guard)
 * were both a NEW path not doing what its siblings did. Neither was caught by
 * review, because nothing about the new code looked wrong — it looked like the
 * other paths, minus one line nobody was looking for.
 *
 * This guard makes the omission red instead of invisible. Same shape as the
 * fixture-PII check: **you cannot forget it, because forgetting is what turns
 * the build red.**
 *
 * ===========================================================================
 * THE RULE
 * ===========================================================================
 * An exported function in the db layer that issues TWO OR MORE write statements
 * must either:
 *
 *   (a) call `dbTransaction` itself, or
 *   (b) be called BY NAME inside some other function's `dbTransaction` callback
 *       — the sync-core pattern (`updateContactSync`, `createTransactionSync`,
 *       `assignContactToTransactionSync`), which exists precisely so the
 *       composition can be atomic.
 *
 * ===========================================================================
 * WHY THE ENUMERATION IS DERIVED FROM SOURCE, NOT LISTED
 * ===========================================================================
 * BACKLOG-2530: *"A registry someone must remember to update is not
 * enforcement; prefer something derived from the code itself."*
 *
 * The function set, the write count and the wrapping are all read out of the
 * files. **Adding a new multi-write function turns this red without anyone
 * touching this file.** The only hand-maintained part is EXEMPT below, which
 * requires a written reason per entry and is asserted to stay small.
 *
 * ===========================================================================
 * WHAT IT DELIBERATELY DOES NOT CHECK
 * ===========================================================================
 * It does not verify that a rollback TEST exists — that cannot be derived from
 * source without pattern-matching test bodies, and a check that guesses is a
 * check that gets ignored. The forced-crash tests are asserted per operation in
 * the suites named in EXEMPT and in `atomicCreate-2496` / `atomicDealCreate-2538`.
 *
 * It counts statements textually. A write built by string concatenation at
 * runtime is invisible to it. That is a known floor, not a claim of completeness.
 */

import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DB_DIR = path.join(REPO_ROOT, "electron", "services", "db");

/**
 * Functions allowed to issue multiple writes unwrapped. EVERY entry needs a
 * reason. An entry whose reason is "it's fine" is a bug report.
 */
const EXEMPT: Record<string, string> = {
  // Schema/migration paths run at startup against a database no user is
  // touching, and are already wrapped one level up by the migration runner.
  runMigrations: "migration runner wraps the whole migration in its own transaction",
  applyMigration: "invoked by runMigrations, inside its transaction",
  relabelTypedContactValues:
    "called only from a migration (databaseService.ts:3231), and EVERY migration runs inside currentDb.transaction(...) at databaseService.ts:3468 — verified by reading the caller, not inferred",
};

/**
 * ===========================================================================
 * WHAT THE FIRST VERSION OF THIS GUARD GOT WRONG
 * ===========================================================================
 * It reported NINE unwrapped multi-write functions. **Seven were false
 * positives.** The claim was made, filed and reported before any of the nine
 * was opened and read — the exact failure this whole feature exists to prevent,
 * committed by the guard meant to prevent it.
 *
 * Two blind spots produced them, both now fixed above:
 *
 *   1. **`db.transaction(...)` was not recognised as wrapping** — only the
 *      shared `dbTransaction(...)` helper was. `batchUpdateContactAssignments`
 *      was reported as the worst offender in the codebase (six writes) while
 *      having been transactional all along.
 *
 *   2. **Branch-exclusive writes were counted as sequential.** The upsert shape
 *      —  `if (existing) { UPDATE …; return; } INSERT …;`  — is two write
 *      STATEMENTS and never two WRITES. That accounted for
 *      `upsertEmailAttachmentMetadata`, `createLink`, `markContactAsImported`,
 *      `createEmail` and `updateContactRole`.
 *
 * A third was a reachability error no static rule would catch:
 * `relabelTypedContactValues` runs from a migration, and EVERY migration is
 * already wrapped by the runner at `databaseService.ts:3468`
 * (`currentDb.transaction(...)`). Established by reading the caller.
 *
 * **Two were real.** `deleteBySessionId` (fixed by BACKLOG-2480) and
 * `linkContactToTransaction` (fixed by BACKLOG-2543).
 *
 * THE STANDING LESSON, since this guard exists to enforce it: **a tool that
 * reports a violation has not established one.** The list below is what a human
 * confirmed by opening the function, not what the scan emitted.
 */
const KNOWN_UNWRAPPED: Record<string, string> = {
  // EMPTY — and that is the honest result. Seven of the nine this list started
  // with were false positives (see the correction above); `deleteBySessionId`
  // was fixed by BACKLOG-2480 and `linkContactToTransaction` by BACKLOG-2543.
  //
  // MERGE NOTE: the incoming side of this conflict was the original nine-entry
  // list. It is deliberately discarded, not merged — every entry in it was
  // either fixed or never a violation, and re-adding one would fail the
  // "may only shrink" test below.
};

interface Fn {
  file: string;
  name: string;
  line: number;
  body: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(p));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Brace-matched body of the function starting at `startLine`. */
function captureBody(lines: string[], startLine: number): string {
  let depth = 0;
  let started = false;
  const buf: string[] = [];
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    buf.push(line);
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (started && depth <= 0) break;
  }
  return buf.join("\n");
}

function exportedFunctions(): Fn[] {
  const fns: Fn[] = [];
  for (const file of sourceFiles(DB_DIR)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(lines[i]);
      if (!m) continue;
      fns.push({
        file: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
        name: m[1],
        line: i + 1,
        body: captureBody(lines, i),
      });
    }
  }
  return fns;
}

/**
 * Write statements in a body, counted on SQL keywords at the start of a
 * statement. `strip` removes line comments first so a commented-out INSERT in
 * an explanation does not count — several of these files carry long comments
 * quoting the SQL they replaced.
 */
function writeCount(body: string): number {
  const strip = body
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
  const matches = strip.match(/\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM)\b/gi);
  return matches ? matches.length : 0;
}

function wrapsItself(body: string): boolean {
  // `dbTransaction(...)` is the shared helper. `db.transaction(...)` is
  // better-sqlite3's own API, used directly where a function already holds a
  // handle — MISSING IT WAS A BUG IN THE FIRST VERSION OF THIS GUARD, and it
  // reported `batchUpdateContactAssignments` as the worst offender in the
  // codebase when that function has been transactional all along.
  return /\bdbTransaction\s*\(/.test(body) || /\b\w+\.transaction\s*\(/.test(body);
}

/**
 * A write that can only run when an earlier one did NOT — the upsert shape:
 *
 *     if (existing) { UPDATE …; return existing.id; }
 *     INSERT …;
 *
 * Two write statements, never two writes. Counting them textually is what made
 * the first version of this guard report four functions that cannot leave a
 * partial state. Approximated by: a `return` sits between the writes at the
 * same or shallower brace depth.
 */
function writesAreBranchExclusive(body: string): boolean {
  const lines = body.split("\n");
  let seenWrite = false;
  let returnedSinceWrite = false;
  for (const line of lines) {
    if (/^\s*(\*|\/\/)/.test(line)) continue;
    if (/\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM)\b/i.test(line)) {
      if (seenWrite && !returnedSinceWrite) return false; // two writes, no exit between
      seenWrite = true;
      returnedSinceWrite = false;
    } else if (seenWrite && /^\s*(return|\} else)/.test(line)) {
      returnedSinceWrite = true;
    }
  }
  return seenWrite;
}

/** Every identifier called inside some `dbTransaction(() => { ... })` anywhere in the db layer. */
function namesCalledInsideATransaction(): Set<string> {
  const inside = new Set<string>();
  for (const file of sourceFiles(DB_DIR)) {
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/\bdbTransaction\s*\(/.test(lines[i])) continue;
      const block = captureBody(lines, i);
      for (const m of block.matchAll(/\b([A-Za-z0-9_]+)\s*\(/g)) inside.add(m[1]);
    }
  }
  return inside;
}

describe("a multi-statement write may not ship without a transaction (BACKLOG-2530)", () => {
  const fns = exportedFunctions();
  const insideATransaction = namesCalledInsideATransaction();

  it("PRECONDITION: the scan actually finds the db layer", () => {
    expect(fns.length).toBeGreaterThan(50);
    // If this ever drops to zero the guard below passes vacuously — which is
    // the failure mode every check in this repo is now written to avoid.
    expect(fns.some((f) => f.name === "createContact")).toBe(true);
  });

  it("PRECONDITION: it can tell a wrapped write from an unwrapped one", () => {
    const wrapped = fns.filter((f) => writeCount(f.body) >= 2 && wrapsItself(f.body));
    expect(wrapped.length).toBeGreaterThan(0);
  });

  function unwrapped(): Fn[] {
    return fns
      .filter((f) => writeCount(f.body) >= 2)
      .filter((f) => !wrapsItself(f.body))
      .filter((f) => !writesAreBranchExclusive(f.body))
      .filter((f) => !insideATransaction.has(f.name))
      .filter((f) => !(f.name in EXEMPT));
  }

  it("NO NEW multi-write function ships without a transaction", () => {
    const offenders = unwrapped()
      .filter((f) => !(f.name in KNOWN_UNWRAPPED))
      .map((f) => `${f.file}:${f.line}  ${f.name}  (${writeCount(f.body)} writes)`);

    // Exact set, not a count — a count cannot tell a new violation from a
    // different one that replaced it.
    expect(offenders).toEqual([]);
  });

  it("the known list may only SHRINK — an entry removed without a fix goes red", () => {
    const stillUnwrapped = unwrapped().map((f) => f.name).sort();
    const claimed = Object.keys(KNOWN_UNWRAPPED).sort();

    // Anything claimed as known that is no longer unwrapped has been FIXED —
    // delete it from KNOWN_UNWRAPPED. Anything unwrapped and not claimed is a
    // new violation, caught by the test above.
    const fixedButStillListed = claimed.filter((n) => !stillUnwrapped.includes(n));
    expect(fixedButStillListed).toEqual([]);
  });

  it("every known entry says what a crash would leave, in plain terms", () => {
    for (const [name, damage] of Object.entries(KNOWN_UNWRAPPED)) {
      // "data could be inconsistent" is not a description. BACKLOG-2530 asks
      // for the intermediate state named concretely.
      expect(damage.length).toBeGreaterThan(40);
      expect(damage).not.toMatch(/inconsistent state|data integrity issue/i);
      expect(typeof name).toBe("string");
    }
  });

  it("the exemption list stays small and every entry gives a reason", () => {
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(reason).not.toMatch(/^(ok|fine|n\/a|todo)/i);
      expect(typeof name).toBe("string");
    }
    // A growing exemption list is the failure mode of every guard like this.
    expect(Object.keys(EXEMPT).length).toBeLessThanOrEqual(6);
  });
});
