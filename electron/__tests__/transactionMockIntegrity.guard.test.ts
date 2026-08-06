/**
 * @jest-environment node
 *
 * BACKLOG-2537 — A SUITE WITH A REAL DATABASE MAY NOT FAKE ITS TRANSACTIONS.
 *
 * ===========================================================================
 * WHAT WENT WRONG
 * ===========================================================================
 * Eleven suites opened a real SQLite database and then stubbed `dbTransaction`
 * as `(fn) => fn()`. Under that stub a transaction is not a transaction: every
 * statement runs, every caller is satisfied, and a throw partway through leaves
 * the earlier writes COMMITTED.
 *
 * Nothing in those files went red because of it, which is the whole problem.
 * The damage was not to any assertion that existed — it was to every atomicity
 * assertion that would be written there LATER. Such a test passes whether or
 * not the production path has a transaction at all, so it reports coverage
 * while being incapable of failing. That is worse than no test.
 *
 * ===========================================================================
 * WHY A GUARD AND NOT A CONVENTION
 * ===========================================================================
 * BACKLOG-2530 makes the same argument about production writes: "Steps 1-3 fix
 * today and rely on every future author remembering. That is a convention, and
 * conventions failed twice on 2026-08-05."
 *
 * The passthrough is not a mistake a reviewer reliably catches, because it
 * looks correct — it is a one-line lambda that does exactly what its name says
 * in the loosest reading. It is caught by a machine or it is not caught.
 *
 * ===========================================================================
 * THE RULE, AND WHY IT IS SCOPED THIS WAY
 * ===========================================================================
 * A file is in scope only if it opens a REAL database. That scoping is
 * deliberate and is the distinction the audit turned on:
 *
 *   real DB + fake transaction   DANGEROUS. "Assert the row is gone" is
 *                                expressible and silently passes.
 *   no DB at all                 HARMLESS. There are no rows, so no atomicity
 *                                claim can be made or mis-made. Thirteen suites
 *                                mock the driver module wholesale — `prepare()`
 *                                returns a sink array and they assert captured
 *                                SQL. Requiring a real transaction of them would
 *                                mean giving them a database, which is a rewrite
 *                                and not a fix.
 *
 * Both the file set and the verdict are DERIVED FROM THE SOURCE. There is no
 * list to update: a new suite that opens a database is in scope the moment it
 * exists, which is the property BACKLOG-2530 asks for ("a registry someone must
 * remember to update is not enforcement").
 */

import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SEARCH_ROOTS = ["electron", "src", "tests"];

/** Every test file under the search roots, as repo-relative paths. */
function testFiles(): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") {
          continue;
        }
        walk(full);
      } else if (/\.test\.tsx?$/.test(entry.name)) {
        found.push(path.relative(REPO_ROOT, full));
      }
    }
  };

  for (const root of SEARCH_ROOTS) walk(path.join(REPO_ROOT, root));
  return found.sort();
}

/**
 * Does this file open a real SQLite database?
 *
 * Two ways exist in the repo: the shared `openTestDb()` helper, and resolving
 * `better-sqlite3-multiple-ciphers` by PATH to bypass the moduleNameMapper stub
 * (which is how the older suites do it). Both are matched.
 */
function opensRealDatabase(source: string): boolean {
  return (
    /\bopenTestDb\s*\(/.test(source) ||
    /path\.join\([^)]*better-sqlite3-multiple-ciphers/.test(source)
  );
}

/**
 * Capture a statement or property that begins on `startLine`, continuing while
 * its brackets are unbalanced.
 *
 * LINE-BASED ON PURPOSE. A character scan that ends at the first depth-zero
 * comma looks more precise and is wrong: it truncates
 * `dbTransaction: <T,>(fn: () => T): T => ...` at the comma inside the GENERIC
 * PARAMETER LIST, leaving `<T` as the "implementation" and reporting a
 * correctly-written suite as an offender. Measured — it produced two false
 * positives on the first run of this guard. Angle brackets cannot be tracked as
 * depth either, because `<` is also a comparison operator.
 *
 * Whole lines sidestep both: a generic list never spans a line, and a
 * multi-line body (the explicit BEGIN/COMMIT/ROLLBACK spelling) is captured to
 * its closing brace.
 */
function captureBlock(lines: string[], startLine: number): string {
  let text = "";
  let depth = 0;

  for (let i = startLine; i < lines.length; i++) {
    text += lines[i] + "\n";
    for (const ch of lines[i]) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
    }
    if (depth <= 0) break;
  }
  return text;
}

/**
 * The text of every `dbTransaction:` mock implementation in a file.
 *
 * RESOLVES INDIRECTION. `dbTransaction: mockDbTransaction,` says nothing on its
 * own; the semantics live at `const mockDbTransaction = jest.fn(...)` further
 * up the file. Reading only the property would judge every such suite a
 * passthrough — the second false positive on this guard's first run, and the
 * more dangerous of the two, because the obvious "fix" is to stop looking.
 */
function dbTransactionImpls(source: string): string[] {
  const lines = source.split("\n");
  const impls: string[] = [];

  lines.forEach((line, idx) => {
    if (!/\bdbTransaction:/.test(line)) return;

    const block = captureBlock(lines, idx);
    const body = block.slice(block.indexOf("dbTransaction:") + "dbTransaction:".length);

    // `dbTransaction: someIdentifier,` — follow it to its declaration.
    const alias = body.match(/^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/m);
    if (alias && !/=>|function|\(/.test(body)) {
      const declIdx = lines.findIndex((l) =>
        new RegExp(`\\b(const|let|var)\\s+${alias[1]}\\b`).test(l),
      );
      impls.push(declIdx === -1 ? body : captureBlock(lines, declIdx));
      return;
    }
    impls.push(body);
  });

  return impls;
}

/**
 * Real transaction semantics, spelled either way the repo spells them:
 * delegating to a driver's `.transaction(fn)`, or an explicit
 * BEGIN / COMMIT / ROLLBACK (which `contactSourceValues.test.ts` uses, because
 * `node:sqlite` has no `.transaction` helper).
 */
function isRealTransaction(impl: string): boolean {
  if (/\.transaction\s*\(/.test(impl)) return true;
  return /\bBEGIN\b/.test(impl) && /\bCOMMIT\b/.test(impl) && /\bROLLBACK\b/.test(impl);
}

/**
 * Files in scope: they open a real database AND they mock `dbTransaction`.
 *
 * THIS FILE IS EXCLUDED FROM ITS OWN SCAN, and that is not a loophole. A file
 * whose job is to recognise source patterns necessarily CONTAINS those
 * patterns — the prose above names `openTestDb()` and the fixtures below spell
 * out every passthrough shape verbatim. On the first run it duly reported
 * itself. The exclusion is by resolved path identity rather than by name, so
 * renaming the guard cannot silently widen it, and it removes exactly one file:
 * the one doing the looking.
 */
function filesInScope(): string[] {
  return testFiles().filter((rel) => {
    const abs = path.join(REPO_ROOT, rel);
    if (abs === __filename) return false;
    const source = fs.readFileSync(abs, "utf8");
    return opensRealDatabase(source) && dbTransactionImpls(source).length > 0;
  });
}

describe("a test suite with a real database may not fake its transactions (BACKLOG-2537)", () => {
  /**
   * THE GUARD.
   *
   * An exact SET, never a count. A count cannot tell "the right file is clean"
   * from "a different file is clean and the offender was never inspected", and
   * those are opposite verdicts. When this fails it names the files.
   */
  it("no suite that opens a real database stubs dbTransaction as a passthrough", () => {
    const offenders = filesInScope().filter((rel) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      return dbTransactionImpls(source).some((impl) => !isRealTransaction(impl));
    });

    expect(offenders).toEqual([]);
  });

  /**
   * THE GUARD'S OWN CONTROL, and the reason this file is not itself a green
   * check that carries no information.
   *
   * A walker that resolved the wrong root, a regex that stopped matching after
   * a refactor, or an extension filter that quietly excluded everything would
   * all leave the assertion above passing over an EMPTY set — indistinguishable
   * from a clean repo. So the scope is asserted to be non-trivial and to
   * contain suites known to open a database.
   *
   * These two names are chosen because they are the least likely in the repo to
   * be deleted: one is the harness's own transaction proof, the other is the
   * atomicity suite BACKLOG-2496 shipped. If either is renamed, this fails and
   * says so — which is correct, because the guard's scope changed.
   */
  it("PRECONDITION: the scan actually reaches the suites it is meant to police", () => {
    const scanned = filesInScope();

    expect(scanned.length).toBeGreaterThan(5);
    expect(scanned).toContain(
      path.join("electron", "services", "db", "__tests__", "contactDbService.atomicCreate-2496.test.ts"),
    );
    expect(scanned).toContain(
      path.join("electron", "__tests__", "contact-handlers.updatePersistence.test.ts"),
    );
  });

  /**
   * PROVES THE DETECTOR CAN SAY NO.
   *
   * Run against fabricated sources rather than the tree, so it keeps working
   * when the tree is clean — which is the state the repo is supposed to be in,
   * and therefore the state in which the assertion above stops discriminating.
   * Without this, "offenders is empty" would be the only signal, and an
   * `isRealTransaction` that returned `true` unconditionally would pass it.
   */
  it("PRECONDITION: the detector rejects each passthrough shape and accepts each real one", () => {
    const verdicts = [
      "<T>(fn: () => T): T => fn(),",
      "<T,>(fn: () => T): T => fn(),",
      "jest.fn((fn: () => unknown) => fn()),",
      "jest.fn().mockImplementation((fn: () => unknown) => fn()),",
      "(fn: () => void) => () => fn(),",
      "<T>(fn: () => T): T => mockDb!.transaction(fn)(),",
      "(fn: () => unknown) => db.transaction(fn)(),",
      "<T>(fn: () => T): T => {\n  mockDb!.exec('BEGIN');\n  try { const out = fn(); mockDb!.exec('COMMIT'); return out; }\n  catch (e) { mockDb!.exec('ROLLBACK'); throw e; }\n},",
    ].map(isRealTransaction);

    // Exact expected verdicts, in order: five fakes rejected, three real ones
    // accepted. The first five are the shapes actually found in this repo on
    // 2026-08-05; the last three are the two accepted spellings.
    expect(verdicts).toEqual([false, false, false, false, false, true, true, true]);
  });
});
