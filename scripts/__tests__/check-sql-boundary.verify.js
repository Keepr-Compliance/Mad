#!/usr/bin/env node
/**
 * VERIFICATION HARNESS for scripts/ci/check-sql-boundary.mjs — BACKLOG-2959
 * =============================================================================
 * A verification harness that never executes is indistinguishable from one that
 * passes. This runs in CI as the "Verify the guard itself" step.
 *
 * Every control below was made to FAIL ON PURPOSE during implementation; a
 * control that has never been seen red proves nothing.
 *
 * Controls
 *   C1a/b/c  a new .prepare( / .exec( / .pragma( outside db/  -> RED  (per verb)
 *   C2       RegExp.exec, literal and `new RegExp(...)` forms  -> GREEN
 *   C3       a baseline entry deleted, code unchanged          -> RED
 *   C4       clean tree + its own committed baseline           -> GREEN
 *   C5       a baseline key matching nothing (stale)           -> RED
 *   C6       swap one violation for another, same file         -> RED  (identity keys)
 *   C7       SQL hoisted into a local const                    -> RED
 *   C8       SQL arriving as a function parameter (tier 3)     -> RED as UNRESOLVABLE
 *   C9       SQL imported from a non-db module                 -> RED
 *   C10      compliant `const sql` + later shadowed literal    -> COMPLIANT then VIOLATION
 *   C11      reassignment / += / parameter shadowing an import -> UNRESOLVABLE (no collateral)
 *   C12      --update-baseline refuses a swap, still allows a shrink
 *   C13      taint spans the DECLARING scope (fails under both approximations)
 *   C14      reassigned regex receiver cannot green .exec() on SQL
 *   C15      module-scoped binding, written in one fn, read in another -> RED
 *   A2a      3-hop alias chain                                 -> UNRESOLVABLE (fail-closed)
 *   A2b      2-hop alias to a db/ import (the :83 shape)       -> COMPLIANT
 *   VSUM     absolute call-site count + COMPLIANT reason census on a known tree
 *
 * WHY ABSOLUTE COUNTS ARE ASSERTED ONLY ON FIXTURE TREES
 *   `in-layer` is designed to climb from 123 toward 310 as BACKLOG-2989/2990/
 *   2991 move SQL into db/**. Asserting a real-tree census would red-bar the
 *   remediation this gate exists to support, and would be "fixed" by
 *   regenerating the number — snapshots regenerated rather than read
 *   (PR-SOP 6.2c). The real tree PRINTS its numbers; fixtures assert them.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const GATE = path.join(REPO_ROOT, "scripts", "ci", "check-sql-boundary.mjs");

const results = [];
const record = (id, name, ok, detail) => results.push({ id, name, ok, detail });

function runGate(args) {
  const r = spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8", cwd: REPO_ROOT });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", all: (r.stdout || "") + (r.stderr || "") };
}

function mkTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlgate-verify-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const DB_MODULE = "electron/services/db/okSql.ts";
const DB_MODULE_SRC = "export const OK_SQL = `SELECT id FROM widgets WHERE owner_id = ?`;\n";
const bl = (dir) => path.join(dir, "baseline.json");

/** Generate a baseline for a tree, then run the gate against it. */
function seedAndRun(dir, extraArgs = []) {
  const gen = runGate(["--root", dir, "--baseline", bl(dir), "--update-baseline"]);
  if (gen.code !== 0) return { seedFailed: true, ...gen };
  return runGate(["--root", dir, "--baseline", bl(dir), ...extraArgs]);
}

// ---------------------------------------------------------------------------
// C1a/b/c — a new site of each verb, in a file with no baseline entry, is RED.
// Run per verb: one input per branch cannot prove three verbs are wired.
// ---------------------------------------------------------------------------
for (const [id, verb, call] of [
  ["C1a", "prepare", 'db.prepare("SELECT 1").get();'],
  ["C1b", "exec", 'db.exec("SELECT 1");'],
  ["C1c", "pragma", 'db.pragma("foreign_keys = ON");'],
]) {
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/handlers/clean.ts": "export function noop() { return 1; }\n",
  });
  // Baseline the CLEAN tree, then introduce the new site.
  const gen = runGate(["--root", dir, "--baseline", bl(dir), "--update-baseline"]);
  fs.writeFileSync(
    path.join(dir, "electron/handlers/clean.ts"),
    `export function q(db: any) { ${call} }\n`
  );
  const r = runGate(["--root", dir, "--baseline", bl(dir)]);
  record(
    id,
    `new .${verb}( outside db/ goes RED`,
    gen.code === 0 && r.code === 1 && /NEW SQL site/.test(r.all),
    `seed=${gen.code} run=${r.code}`
  );
}

// ---------------------------------------------------------------------------
// C2 — RegExp.exec is not a database call. Both regex-literal and `new RegExp`.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/utils/re.ts": [
      "const LITERAL_PATTERN = /^abc(\\d+)$/;",
      "export function a(s: string) { return LITERAL_PATTERN.exec(s); }",
      "export function b(src: string, flags: string, s: string) {",
      "  const built = new RegExp(src, flags);",
      "  return built.exec(s);",
      "}",
      "",
    ].join("\n"),
  });
  const r = seedAndRun(dir, ["--json"]);
  let ok = false, detail = `code=${r.code}`;
  try {
    const j = JSON.parse(r.out);
    ok = r.code === 0 && j.violation === 0 && j.unresolvable === 0 && j.complianceReasons.regex === 2;
    detail = `violation=${j.violation} unresolvable=${j.unresolvable} regex=${j.complianceReasons.regex}`;
  } catch { /* ok stays false; detail carries the code */ }
  record("C2", "RegExp.exec (literal and new RegExp) stays GREEN", ok, detail);
}

// ---------------------------------------------------------------------------
// C3 — deleting a baseline entry without fixing the code is RED.
// Proves the baseline is a ledger, not a blanket suppression.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/handlers/h.ts": 'export function q(db: any) { db.prepare("SELECT 1").get(); }\n',
  });
  runGate(["--root", dir, "--baseline", bl(dir), "--update-baseline"]);
  const before = runGate(["--root", dir, "--baseline", bl(dir)]);
  const raw = JSON.parse(fs.readFileSync(bl(dir), "utf8"));
  raw.entries = [];
  fs.writeFileSync(bl(dir), JSON.stringify(raw, null, 2));
  const after = runGate(["--root", dir, "--baseline", bl(dir)]);
  record(
    "C3",
    "baseline entry deleted without a fix goes RED",
    before.code === 0 && after.code === 1 && /NEW SQL site/.test(after.all),
    `before=${before.code} after=${after.code}`
  );
}

// ---------------------------------------------------------------------------
// C4 — a tree with its own committed baseline is GREEN.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/handlers/h.ts": 'export function q(db: any) { db.prepare("SELECT 1").get(); }\n',
  });
  const r = seedAndRun(dir);
  record("C4", "clean tree + committed baseline is GREEN", r.code === 0 && /^OK/m.test(r.out), `code=${r.code}`);
}

// ---------------------------------------------------------------------------
// C5 — a baseline key matching no current violation is RED (stale).
// This is what forces items 2989/2990/2991 to ratchet the file down in the
// same commit as the move, instead of leaving a baseline nobody shrinks.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/handlers/h.ts": 'export function q(db: any) { db.prepare("SELECT 1").get(); }\n',
  });
  runGate(["--root", dir, "--baseline", bl(dir), "--update-baseline"]);
  const raw = JSON.parse(fs.readFileSync(bl(dir), "utf8"));
  raw.entries.push({
    file: "electron/handlers/h.ts",
    verb: "prepare",
    match: "text:ffffffffffff",
    bucket: "VIOLATION",
    count: 1,
    owner: "BACKLOG-2989",
  });
  fs.writeFileSync(bl(dir), JSON.stringify(raw, null, 2));
  const r = runGate(["--root", dir, "--baseline", bl(dir)]);
  record("C5", "stale baseline key goes RED", r.code === 1 && /no longer match/.test(r.all), `code=${r.code}`);
}

// ---------------------------------------------------------------------------
// C6 — swap one violation for a DIFFERENT one in a baselined file.
// GREEN under per-file counts. RED under identity keys. This is the only
// control that discriminates the two baseline designs.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/handlers/h.ts": 'export function q(db: any) { db.prepare("SELECT alpha FROM t").get(); }\n',
  });
  runGate(["--root", dir, "--baseline", bl(dir), "--update-baseline"]);
  const before = runGate(["--root", dir, "--baseline", bl(dir)]);
  fs.writeFileSync(
    path.join(dir, "electron/handlers/h.ts"),
    'export function q(db: any) { db.prepare("SELECT beta FROM t").get(); }\n'
  );
  const after = runGate(["--root", dir, "--baseline", bl(dir)]);
  const swapped = /NEW SQL site/.test(after.all) && /no longer match/.test(after.all);
  record(
    "C6",
    "swapping one query for another (count unchanged) goes RED",
    before.code === 0 && after.code === 1 && swapped,
    `before=${before.code} after=${after.code} bothSignals=${swapped}`
  );
}

// ---------------------------------------------------------------------------
// C7 — SQL hoisted into a local const. Invisible to argument-shape alone.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/handlers/h.ts": [
      "export function q(db: any, id: string) {",
      "  const sql = `SELECT id FROM widgets WHERE id = '${id}'`;",
      "  return db.prepare(sql).get();",
      "}",
      "",
    ].join("\n"),
  });
  const r = seedAndRun(dir, ["--json"]);
  let ok = false, detail = `code=${r.code}`;
  try {
    const j = JSON.parse(r.out);
    ok = j.violation === 1 && j.unresolvable === 0;
    detail = `violation=${j.violation} unresolvable=${j.unresolvable}`;
  } catch { /* ok stays false */ }
  record("C7", "SQL hoisted into a local const is a VIOLATION", ok, detail);
}

// ---------------------------------------------------------------------------
// C8 — SQL arriving as a function parameter: the tier-3 shape.
// Must be RED as UNRESOLVABLE — not green, and not a crash. Routing SQL through
// a helper parameter is itself the untraceability the rule prevents.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/services/diag.ts": [
      "export function make(db: any) {",
      "  const runSql = (sql: string) => db.prepare(sql).get();",
      "  return runSql;",
      "}",
      "",
    ].join("\n"),
  });
  const r = seedAndRun(dir, ["--json"]);
  let ok = false, detail = `code=${r.code}`;
  try {
    const j = JSON.parse(r.out);
    ok = r.code === 0 && j.unresolvable === 1 && j.violation === 0 && j.baselineEligible === 1;
    detail = `unresolvable=${j.unresolvable} baselineEligible=${j.baselineEligible}`;
  } catch { /* ok stays false */ }
  // It is baseline-eligible (a violation); with its own baseline the run is green.
  // The RED half is proved by the same shape appearing in a tree baselined clean.
  const dir2 = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/services/diag.ts": "export function make() { return 1; }\n",
  });
  runGate(["--root", dir2, "--baseline", bl(dir2), "--update-baseline"]);
  fs.writeFileSync(
    path.join(dir2, "electron/services/diag.ts"),
    "export function make(db: any) {\n  const runSql = (sql: string) => db.prepare(sql).get();\n  return runSql;\n}\n"
  );
  const r2 = runGate(["--root", dir2, "--baseline", bl(dir2)]);
  record(
    "C8",
    "SQL as a function parameter is RED as UNRESOLVABLE (not green, not a crash)",
    ok && r2.code === 1 && /UNRESOLVABLE/.test(r2.all),
    `${detail} newSiteRun=${r2.code}`
  );
}

// ---------------------------------------------------------------------------
// C9 — SQL imported from a NON-db module. This branch fires on zero sites in
// the real tree; without this control it would be a rule nobody has run.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/services/notDb.ts": "export const SNEAKY_SQL = `SELECT id FROM widgets`;\n",
    "electron/handlers/h.ts": [
      'import { SNEAKY_SQL } from "../services/notDb";',
      "export function q(db: any) { return db.prepare(SNEAKY_SQL).get(); }",
      "",
    ].join("\n"),
  });
  const r = seedAndRun(dir, ["--json"]);
  let ok = false, detail = `code=${r.code}`;
  try {
    const j = JSON.parse(r.out);
    const base = JSON.parse(fs.readFileSync(bl(dir), "utf8"));
    const entry = base.entries.find((e) => e.file === "electron/handlers/h.ts");
    // Keyed as import:<specifier>#<name>, not a hash of text that is not there.
    ok = j.violation === 1 && !!entry && entry.match === "import:../services/notDb#SNEAKY_SQL";
    detail = `violation=${j.violation} match=${entry ? entry.match : "none"}`;
  } catch { /* ok stays false */ }
  record("C9", "non-db import is a VIOLATION keyed import:<spec>#<name>", ok, detail);
}

// ---------------------------------------------------------------------------
// C10 — nearest-preceding declaration (amendment A1).
// One file holding a compliant `const sql = <db import>` AND a later, shadowed
// `const sql = <template literal>`. Asserting only the compliant half would
// re-admit the defect: under file-wide first-wins the interpolated SELECT was
// classified COMPLIANT. Both halves are asserted.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/workers/shadow.ts": [
      'import { OK_SQL } from "../services/db/okSql";',
      "export function compliant(db: any, id: string) {",
      "  const sql = OK_SQL;",
      "  return db.prepare(sql).all(id);",
      "}",
      "export function shadowed(db: any, term: string) {",
      "  const sql = `SELECT id FROM widgets WHERE label LIKE '%${term}%'`;",
      "  return db.prepare(sql).all();",
      "}",
      "",
    ].join("\n"),
  });
  const r = seedAndRun(dir, ["--explain"]);
  const lines = r.all.split("\n").filter((l) => l.includes("shadow.ts"));
  const compliantHalf = lines.some((l) => /COMPLIANT\s+from-db-import/.test(l));
  const violationHalf = lines.some((l) => /VIOLATION\s+sql-text-authored-outside-db-layer/.test(l));
  record(
    "C10",
    "compliant const + later shadowed literal: first COMPLIANT, second VIOLATION",
    compliantHalf && violationHalf && lines.length === 2,
    `compliant=${compliantHalf} violation=${violationHalf} sites=${lines.length}`
  );
}

// ---------------------------------------------------------------------------
// C11 — a name written by a form the binding map does not model.
//
// The map knows two forms (declaration-with-initializer, named import). An
// assignment, `+=`, or a shadowing parameter is invisible to it, so without
// taint the use resolves PAST the write to the modelled declaration above and
// classifies COMPLIANT -- greening interpolated SQL. That is not exotic:
// `let sql = ...; sql += ...` is the dominant query-assembly idiom inside
// electron/services/db/ itself, and a half-move of iosMessagesParser.ts:674
// (BACKLOG-2990) would drop its baseline entry to zero while the file still
// authors `LIMIT ${...}` outside db/ -- a false DONE on the remediation path.
//
// All three halves are asserted. Asserting only the red halves would permit a
// file-wide taint, which reds the LEGITIMATE use of the same import in the same
// file; that collateral would grow as remediation lands and from-db-import
// climbs from 3.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/workers/written.ts": [
      'import { OK_SQL } from "../services/db/okSql";',
      "// (i) reassignment: the write is invisible to the binding map",
      "export function reassigned(db: any, legacy: boolean, term: string) {",
      "  let sql = OK_SQL;",
      "  if (legacy) sql = `SELECT id FROM widgets WHERE label LIKE '%${term}%'`;",
      "  return db.prepare(sql).all();",
      "}",
      "// (ii) append: the shape used throughout electron/services/db/",
      "export function appended(db: any, limit: number) {",
      "  let sql = OK_SQL;",
      "  sql += ` LIMIT ${Math.floor(limit)}`;",
      "  return db.prepare(sql).all();",
      "}",
      "// (iii) a parameter shadowing the db import",
      "export function shadowed(db: any, OK_SQL: string) { return db.prepare(OK_SQL).all(); }",
      "// (iv) the write is in a NESTED callback, the use is in the enclosing scope.",
      "// This is why the taint span is the OUTERMOST enclosing function: an",
      "// innermost walk taints only the arrow body and leaves the use compliant.",
      "// `forEach` + `+=` is the canonical dynamic-WHERE assembly idiom.",
      "export function nestedWrite(db: any, filters: string[]) {",
      "  let sql = OK_SQL;",
      "  filters.forEach((f) => { sql += ` AND ${f} = ?`; });",
      "  return db.prepare(sql).all();",
      "}",
      "// (v) the legitimate use of the same import in a SIBLING TOP-LEVEL function",
      "// -- must NOT be collaterally reddened",
      "export function legitimate(db: any) { return db.prepare(OK_SQL).all(); }",
      "",
    ].join("\n"),
  });
  const r = seedAndRun(dir, ["--explain"]);
  const lines = r.all.split("\n").filter((l) => l.includes("written.ts"));
  const unresolvable = lines.filter((l) => /UNRESOLVABLE/.test(l)).length;
  const compliant = lines.filter((l) => /COMPLIANT\s+from-db-import/.test(l)).length;
  record(
    "C11",
    "unmodelled writes (reassign, +=, param shadow, nested-callback write) are UNRESOLVABLE; the sibling top-level use stays COMPLIANT",
    lines.length === 5 && unresolvable === 4 && compliant === 1,
    `sites=${lines.length} unresolvable=${unresolvable} compliant=${compliant} (want 5/4/1)`
  );
}

// ---------------------------------------------------------------------------
// A2a / A2b — the alias cutoff and its fail direction.
// A2a proves exceeding the cutoff fails CLOSED (UNRESOLVABLE = violation), so
// the cutoff is a precision knob, not a safety knob. A2b proves it is high
// enough for the shape the rule's own exemplar uses
// (electron/workers/contactQueryWorker.ts:83).
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/services/threehop.ts": [
      "export function q(db: any) {",
      "  const a = `SELECT 1`;",
      "  const b = a;",
      "  const c = b;",
      "  return db.prepare(c).get();",
      "}",
      "",
    ].join("\n"),
  });
  const r = seedAndRun(dir, ["--json"]);
  let ok = false, detail = `code=${r.code}`;
  try {
    const j = JSON.parse(r.out);
    // okSql.ts exports a const and holds no call sites, so nothing is COMPLIANT
    // here: the chain's single site must land in UNRESOLVABLE, not VIOLATION and
    // not COMPLIANT. That is the fail-closed direction.
    ok = j.callSites === 1 && j.unresolvable === 1 && j.violation === 0 && j.compliant === 0;
    detail = `sites=${j.callSites} U=${j.unresolvable} V=${j.violation} C=${j.compliant}`;
  } catch { /* ok stays false */ }
  record("A2a", "3-hop alias chain fails CLOSED (UNRESOLVABLE, counts as a violation)", ok, detail);
}
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/workers/twohop.ts": [
      'import { OK_SQL } from "../services/db/okSql";',
      "export function q(db: any, id: string) {",
      "  const sql = OK_SQL;",
      "  return db.prepare(sql).all(id);",
      "}",
      "",
    ].join("\n"),
  });
  const r = seedAndRun(dir, ["--json"]);
  let ok = false, detail = `code=${r.code}`;
  try {
    const j = JSON.parse(r.out);
    ok = r.code === 0 && j.violation === 0 && j.unresolvable === 0 && j.complianceReasons["from-db-import"] === 1;
    detail = `fromDbImport=${j.complianceReasons["from-db-import"]} violation=${j.violation}`;
  } catch { /* ok stays false */ }
  record("A2b", "2-hop alias to a db/ import is COMPLIANT (the :83 shape)", ok, detail);
}

// ---------------------------------------------------------------------------
// C14 — taint applies at BOTH call sites of nearestPreceding.
//
// isRegexReceiver resolves a name the same way classifyArg does, so it needed
// the same taint check. A reassigned regex variable otherwise keeps `regex` as
// a COMPLIANT reason for a call whose argument is interpolated SQL. Nobody
// writes this, but "the name is provably a RegExp" is a POSITIVE PROOF, and a
// proof built on a name the model cannot track is exactly what taint exists to
// refuse. C2 (the honest RegExp cases) must stay green alongside it.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/workers/rx.ts": [
      "export function e1(db: any, id: string) {",
      "  let r = /^abc$/;",
      "  r = db;",
      "  return r.exec(`DELETE FROM widgets WHERE id = '${id}'`);",
      "}",
      "",
    ].join("\n"),
  });
  const r = seedAndRun(dir, ["--json"]);
  let ok = false, detail = `code=${r.code}`;
  try {
    const j = JSON.parse(r.out);
    // The receiver is tainted, so `regex` is refused and the argument is judged
    // on its own: an interpolated template literal -> VIOLATION.
    ok = j.callSites === 1 && j.compliant === 0 && (j.violation + j.unresolvable) === 1 &&
         (j.complianceReasons.regex ?? 0) === 0;
    detail = `sites=${j.callSites} C=${j.compliant} V=${j.violation} U=${j.unresolvable} regex=${j.complianceReasons.regex ?? 0}`;
  } catch { /* ok stays false */ }
  record("C14", "a reassigned regex receiver cannot green .exec() on interpolated SQL", ok, detail);
}

// ---------------------------------------------------------------------------
// C13 — the taint span is the scope that DECLARES the name.
//
// This is the property, not a snapshot of one implementation. It fails under
// BOTH earlier approximations, which is what makes it the right control:
//
//   innermost function around the write -> (b) `read` is not tainted, because
//     the write sits in a SIBLING closure. False green.
//   outermost function around the write -> (a) `legit` IS tainted, because a
//     sibling closure's parameter shares the outer span. False red.
//
// Only "span = the declaring scope" gives (a) COMPLIANT and (b) UNRESOLVABLE.
//
// This replaces an earlier C13 that asserted the outermost rule's false red as
// a permanent limit. That limit no longer exists, so the control was rewritten
// to the property it had been protecting rather than deleted.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/workers/scopes.ts": [
      'import { OK_SQL } from "../services/db/okSql";',
      "// (a) each closure declares its OWN binding: no cross-taint between siblings",
      "export function ownBindings(db: any) {",
      "  const legit = () => { const sql = OK_SQL; return db.prepare(sql).all(); };",
      "  const taken = (sql: string) => db.prepare(sql).all();",
      "  return { legit, taken };",
      "}",
      "// (b) the binding is declared in the ENCLOSING scope, so a write in one",
      "// closure taints the sibling that reads it",
      "export function sharedBinding(db: any, term: string) {",
      "  let sql = OK_SQL;",
      "  const write = () => { sql = `SELECT id FROM widgets WHERE label LIKE '%${term}%'`; };",
      "  const read = () => db.prepare(sql).all();",
      "  return { write, read };",
      "}",
      "",
    ].join("\n"),
  });
  const r = seedAndRun(dir, ["--explain"]);
  const lines = r.all.split("\n").filter((l) => l.includes("scopes.ts"));
  const compliant = lines.filter((l) => /COMPLIANT\s+from-db-import/.test(l)).length;
  const unresolvable = lines.filter((l) => /UNRESOLVABLE/.test(l)).length;
  record(
    "C13",
    "taint spans the DECLARING scope: own-binding siblings stay COMPLIANT, a shared binding taints the sibling reader",
    lines.length === 3 && compliant === 1 && unresolvable === 2,
    `sites=${lines.length} compliant=${compliant} unresolvable=${unresolvable} (want 3/1/2)`
  );
}

// ---------------------------------------------------------------------------
// C15 — a module-scoped binding, written in one function, read in another.
//
//     let cachedSql = <db import>;                    // module scope
//     export function configure(t) { cachedSql = `... ${t}`; }
//     export function run(db) { db.prepare(cachedSql); }
//
// A lazily-built or memoised module-level query. Both position-based spans miss
// it: the write's innermost AND outermost enclosing function are both
// `configure`, and the read is in `run`. Only the declaring scope (here, the
// source file) covers both.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/handlers/cached.ts": [
      'import { OK_SQL } from "../services/db/okSql";',
      "let cachedSql = OK_SQL;",
      "export function configure(term: string) {",
      "  cachedSql = `SELECT id FROM widgets WHERE label LIKE '%${term}%'`;",
      "}",
      "export function run(db: any) { return db.prepare(cachedSql).all(); }",
      "",
    ].join("\n"),
  });
  const r = seedAndRun(dir, ["--json"]);
  let ok = false, detail = `code=${r.code}`;
  try {
    const j = JSON.parse(r.out);
    ok = j.callSites === 1 && j.compliant === 0 && j.unresolvable === 1 && j.violation === 0;
    detail = `sites=${j.callSites} C=${j.compliant} U=${j.unresolvable} V=${j.violation}`;
  } catch { /* ok stays false */ }
  record("C15", "module-scoped binding written in one function and read in another is UNRESOLVABLE", ok, detail);
}

// ---------------------------------------------------------------------------
// C12 — --update-baseline refuses a SWAP, and still allows a shrink.
//
// A total-based growth guard lets a swap through: remove one baselined query,
// add a brand-new one, total unchanged, regeneration succeeds silently -- while
// the baseline's own $comment claims it cannot. The guard compares KEYS.
// Both halves are asserted: refusing the swap is worthless if it also blocks
// the ratchet-down that items 2989/2990/2991 depend on.
// ---------------------------------------------------------------------------
{
  const two = 'export function q(db: any) { db.prepare("SELECT alpha FROM t").get(); db.prepare("SELECT beta FROM t").get(); }\n';
  const dir = mkTree({ [DB_MODULE]: DB_MODULE_SRC, "electron/handlers/h.ts": two });
  runGate(["--root", dir, "--baseline", bl(dir), "--update-baseline"]);

  // (i) SWAP: beta -> gamma. Same count, one brand-new key.
  fs.writeFileSync(
    path.join(dir, "electron/handlers/h.ts"),
    'export function q(db: any) { db.prepare("SELECT alpha FROM t").get(); db.prepare("SELECT gamma FROM t").get(); }\n'
  );
  const swap = runGate(["--root", dir, "--baseline", bl(dir), "--update-baseline"]);
  const swapRefused = swap.code === 1 && /REFUSING to record/.test(swap.all);
  const allowed = runGate(["--root", dir, "--baseline", bl(dir), "--update-baseline", "--allow-growth"]);

  // (ii) SHRINK: drop one query entirely. Must regenerate with NO flag.
  fs.writeFileSync(
    path.join(dir, "electron/handlers/h.ts"),
    'export function q(db: any) { db.prepare("SELECT alpha FROM t").get(); }\n'
  );
  const shrink = runGate(["--root", dir, "--baseline", bl(dir), "--update-baseline"]);
  const after = runGate(["--root", dir, "--baseline", bl(dir)]);
  const shrank = shrink.code === 0 && after.code === 0 &&
    JSON.parse(fs.readFileSync(bl(dir), "utf8")).totalSites === 1;

  record(
    "C12",
    "--update-baseline refuses a swap (same total, new key) but still allows a shrink",
    swapRefused && allowed.code === 0 && shrank,
    `swapRefused=${swapRefused} allowGrowth=${allowed.code} shrank=${shrank}`
  );
}

// ---------------------------------------------------------------------------
// C16 — a db/ module cannot launder text defined outside the layer.
//
// `from-db-import` claims the text ORIGINATES in db/, but the specifier is
// resolved one hop and only asks where the module SITS. A two-line barrel
// inside the layer re-exporting outward makes every importer read COMPLIANT on
// a proof it does not have -- and that falsifies the "fail-closed, never a
// false green" guarantee the classifier limits state.
//
// All four halves are asserted. The two exemptions matter as much as the two
// violations: db/index.ts carries 15 legitimate inward `export * from "./..."`
// today, and a type-only re-export carries no runtime string. A control that
// only asserted the red halves would permit a check that reds all of those.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    [DB_MODULE]: DB_MODULE_SRC,
    "electron/handlers/outsideA.ts":
      "export const A_SQL = `SELECT id FROM widgets`;\nexport type Row = { id: string };\n",
    "electron/handlers/outsideB.ts": "export const B_SQL = `SELECT label FROM widgets`;\n",
    "electron/services/db/inner.ts": "export const INNER_SQL = `SELECT 1`;\n",
    "electron/services/db/barrel.ts": [
      '// (i) named re-export pointing OUT of the layer -> VIOLATION',
      'export { A_SQL } from "../../handlers/outsideA";',
      '// (ii) star re-export pointing OUT of the layer -> VIOLATION',
      'export * from "../../handlers/outsideB";',
      '// (iii) inward re-export -> clean (db/index.ts has 15 of these)',
      'export * from "./inner";',
      '// (iv) type-only re-export carries no runtime string -> clean',
      'export type { Row } from "../../handlers/outsideA";',
      "",
    ].join("\n"),
  });
  const r = seedAndRun(dir, ["--explain"]);
  const rex = r.all.split("\n").filter((l) => /reexport:/.test(l));
  const named = rex.filter((l) => /reexport:\.\.\/\.\.\/handlers\/outsideA/.test(l)).length;
  const star = rex.filter((l) => /reexport:\.\.\/\.\.\/handlers\/outsideB/.test(l)).length;
  const inward = rex.filter((l) => /reexport:\.\/inner/.test(l)).length;
  record(
    "C16",
    "a db/ barrel re-exporting outward is a VIOLATION (both forms); inward and type-only re-exports stay clean",
    rex.length === 2 && named === 1 && star === 1 && inward === 0,
    `findings=${rex.length} named=${named} star=${star} inward=${inward} (want 2/1/1/0)`
  );
}

// ---------------------------------------------------------------------------
// VSUM — a tree of KNOWN contents. Asserts the absolute call-site count and the
// COMPLIANT reason census by name.
//
// The gate's internal buckets-sum check is a no-fourth-bucket guard, NOT a
// completeness check: a silently skipped file contributes zero to both sides.
// Only an absolute expected count over known contents detects skipped input,
// and only a per-reason census detects a site drifting between COMPLIANT
// reasons — which is what caught the alias-cutoff regression during planning,
// while the sum stayed correct in both the broken and the fixed run.
// ---------------------------------------------------------------------------
{
  const dir = mkTree({
    // 2 in-layer sites
    [DB_MODULE]: DB_MODULE_SRC + 'export function r(db: any) { db.prepare("SELECT 2").get(); db.exec("SELECT 3"); }\n',
    // 1 from-db-import
    "electron/workers/w.ts": [
      'import { OK_SQL } from "../services/db/okSql";',
      "export function q(db: any) { return db.prepare(OK_SQL).all(); }",
      "",
    ].join("\n"),
    // 1 regex
    "electron/utils/re.ts": "const P = /x(\\d)/;\nexport function a(s: string) { return P.exec(s); }\n",
    // 1 violation
    "electron/handlers/h.ts": 'export function q(db: any) { db.prepare("SELECT 4").get(); }\n',
    // 1 unresolvable
    "electron/services/d.ts": "export function m(db: any) { const f = (sql: string) => db.prepare(sql).get(); return f; }\n",
  });
  const r = seedAndRun(dir, [
    "--json",
    "--expect-sites", "6",
    "--expect-reasons", "in-layer=2,from-db-import=1,regex=1",
  ]);
  let ok = false, detail = `code=${r.code}`;
  try {
    const j = JSON.parse(r.out);
    ok =
      r.code === 0 &&
      j.callSites === 6 &&
      j.compliant === 4 &&
      j.violation === 1 &&
      j.unresolvable === 1 &&
      j.compliant + j.violation + j.unresolvable === j.callSites;
    detail = `sites=${j.callSites} C=${j.compliant} V=${j.violation} U=${j.unresolvable}`;
  } catch { /* ok stays false */ }
  record("VSUM", "known tree: absolute site count + COMPLIANT reason census by name", ok, detail);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
let failed = 0;
console.log("check-sql-boundary.mjs — guard verification\n");
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(5)} ${r.name}${r.ok ? "" : `\n          -> ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} controls passed.`);
if (failed) {
  console.error(`\n${failed} control(s) FAILED. The guard does not behave as specified.`);
  process.exit(1);
}
process.exit(0);
