#!/usr/bin/env node
/**
 * SQL BOUNDARY GATE — BACKLOG-2959
 * =============================================================================
 * THE RULE
 *
 *   SQL *text* is defined only in `electron/services/db/**` — the `*Sql.ts`
 *   pattern that already exists in the tree.
 *
 *   *Executing* declared SQL against a non-singleton handle is permitted where
 *   declared: worker threads, backup/manifest database files, schema bootstrap
 *   and the encryption-rebuild path. That exception licenses EXECUTING on a
 *   non-singleton handle. It never licenses DEFINING text outside `db/`.
 *
 * WHY ALL THREE VERBS
 *   A `.prepare(`-only gate is decorative: it would pass a file holding raw
 *   `db.exec()` DDL. The gate matches `.prepare(`, `.exec(` and `.pragma(`.
 *
 * WHY THE ARGUMENT, NOT THE RECEIVER
 *   `RegExp.exec` is not SQL. Rather than blacklisting receiver names, the gate
 *   asks where argument 0's TEXT comes from. Compliant SQL passes an identifier
 *   imported from `db/`; a violation inlines a literal. Measured at cd08d2641:
 *   all 9 `RegExp.exec` sites pass non-literals, so no name blacklist is needed.
 *
 * THREE BUCKETS, NO FOURTH
 *   Every enumerated call site lands in exactly one of COMPLIANT / VIOLATION /
 *   UNRESOLVABLE. There is no "could not classify, assume fine" category:
 *   UNRESOLVABLE counts as a violation and is baselined with an owner. Each
 *   COMPLIANT site carries a POSITIVE proof, never an assumption.
 *
 * ALIAS DEPTH AND ITS FAIL DIRECTION (BACKLOG-2959 amendment A2)
 *   Identifier resolution follows at most ALIAS_DEPTH_CUTOFF hops. Two is the
 *   MINIMUM that satisfies the `const sql = <db import>` shape at
 *   electron/workers/contactQueryWorker.ts:83, which the rule's own exemplar
 *   uses. Beyond the cutoff the classifier returns UNRESOLVABLE — which counts
 *   as a violation — so exceeding the cutoff can only ever produce a FALSE RED,
 *   never a false green. The cutoff is a precision knob, not a safety knob.
 *
 * NEAREST-PRECEDING RESOLUTION (amendment A1)
 *   An identifier resolves to the nearest declaration PRECEDING the use site,
 *   not the first declaration in the file. A file-wide first-wins map lets one
 *   compliant `const sql = <db import>` green every later `db.prepare(sql)` in
 *   the same file — including a raw interpolated SELECT. Control C10 pins this.
 *
 * UNMODELLED WRITES ARE TAINTED (amendment A5)
 *   The binding map models two forms: a declaration with an initializer, and a
 *   named import. Any OTHER write or binding of a name — assignment, `+=`,
 *   parameter, destructuring, catch variable, uninitialised `let` — taints that
 *   name, and a tainted name can never yield COMPLIANT. Without this,
 *   `let sql = <db import>; sql += ...` resolved past the write to the import
 *   and greened interpolated SQL.
 *
 *   THE SPAN IS THE SCOPE THAT DECLARES THE NAME. The property being protected
 *   — "this name may hold something the model cannot see" — belongs to the
 *   BINDING, so the span is the binding's scope. Two earlier revisions
 *   approximated it with the syntactic position of the write, and an
 *   approximation of a binding scope can be wrong in both directions; both
 *   happened, and each admitted a false green:
 *
 *     innermost function around the write  -> too narrow: a write in a callback
 *       left the enclosing-scope read COMPLIANT
 *       (`filters.forEach((f) => { sql += ... }); db.prepare(sql)`)
 *     outermost function around the write  -> still too narrow for a
 *       module-scoped name written in a sibling function, and too wide for
 *       sibling closures (a false red, since removed)
 *
 *   Using the declaring scope closes both directions at once and is not an
 *   approximation, so "too narrow" and "too wide" stop being available failure
 *   directions. Taint is checked at BOTH places that resolve a name
 *   (`classifyArg` and `isRegexReceiver`), not just the first.
 *
 *   Taint downgrades only FROM_DB; a name resolving to a LITERAL still keys as
 *   LITERAL, so the baseline does not move.
 *
 * LAYER INTEGRITY — what keeps `from-db-import` honest
 *   `from-db-import` asserts the text ORIGINATES in the layer, but a specifier
 *   is resolved one hop and only says where a module SITS. A two-line barrel
 *   inside `db/` re-exporting outward would launder text defined elsewhere and
 *   green it for every importer. So a `db/` file whose `export ... from`
 *   resolves outside `db/` is itself a VIOLATION, raised AT THE BARREL (see
 *   scanFile). Without that check the fail-closed statement below is false.
 *
 * KNOWN LIMITS — where the CLASSIFIER can be wrong.
 *   Each of these is fail-closed: it can produce a false RED, never a false
 *   green. None exists in the tree today. That claim covers the classifier and
 *   depends on the layer-integrity check above; it does NOT extend to the two
 *   NOT ENFORCED axes further down, which are a different guarantee.
 *
 *   Standing rule for anyone adding to this list: a limit ships with a control
 *   that exercises it. Limits 1-4 map to C8, C8/A2a, C13's positional half and
 *   the flow fixture; axes A and B have fixtures but are not enforced.
 *   1. Resolution never crosses a function boundary. SQL passed INTO a helper
 *      (`const run = (sql: string) => db.prepare(sql)`) is UNRESOLVABLE, which
 *      counts as a violation. That case is reported.
 *   2. Interprocedural flow is not modelled: this gate cannot say whether the
 *      text a helper receives originated in `db/`. It reports that it cannot
 *      tell; it does not certify the site.
 *   3. Nearest-preceding is positional, not lexical. A `const` inside a nested
 *      function textually precedes a later use in the OUTER scope, so that use
 *      can resolve to it — a false RED on a compliant site.
 *   4. Taint is scope-exact but not FLOW-exact. It cannot tell a write that
 *      precedes a read from one that follows it, or a branch never taken, so a
 *      name written anywhere in its declaring scope is tainted for all of it.
 *      Over-tainting is the fail-closed direction.
 *
 * NOT ENFORCED — two axes the gate does not cover at all. These are a DIFFERENT
 *   guarantee from the classifier limits above: a site here is not classified
 *   COMPLIANT, it is never enumerated. Both are swept and empty today; neither
 *   is closed in principle.
 *   A. MATCHER SHAPE. For BETTER-SQLITE3, only `<expr>.prepare(...)` /
 *      `.exec(...)` / `.pragma(...)` property-access calls are enumerated.
 *      `db["prepare"](sql)`, `db.prepare.bind(db)(sql)` and
 *      `const { prepare } = db; prepare(sql)` produce ZERO call sites —
 *      invisible, absent from the census entirely.
 *      Zero instances in the tree; re-measured 2026-09-02, still zero for these
 *      three verbs (0 aliased, 0 destructured).
 *
 *      NODE-SQLITE3 is a SEPARATE matcher and this axis does not describe it.
 *      BACKLOG-3059 added it, and it DOES follow aliases — `const dbAll =
 *      db.all; dbAll(sql)` is enumerated — because that form has 4 instances in
 *      the tree and is how Apple's databases are read. It can do so safely only
 *      because it anchors on receiver provenance (`openSqliteReadOnly`) rather
 *      than on verb names; see NODE_SQLITE_VERBS. Controls C17, C18, C19.
 *
 *      The two were confused once, in BACKLOG-3059's own filing: "the header
 *      claims zero and that claim is false" — it was measuring `.all` aliases
 *      against a sentence about `.prepare` aliases. The claim was true. Read
 *      this axis as being about THESE THREE VERBS only.
 *
 *      Closing the better-sqlite3 half means matching bare calls, which
 *      reintroduces the receiver-name blacklist this design deliberately avoids.
 *   B. ENUMERATION. `.ts`/`.tsx` only. The single non-TS source file under
 *      `electron/` or `src/` is a 7-line `electron/main.js` with no db calls,
 *      and no tracked non-TS file in either tree contains any of the three
 *      verbs. Bounded today, unbounded in principle.
 *
 * USAGE
 *   node scripts/ci/check-sql-boundary.mjs
 *   node scripts/ci/check-sql-boundary.mjs --explain
 *   node scripts/ci/check-sql-boundary.mjs --update-baseline [--allow-growth]
 *   node scripts/ci/check-sql-boundary.mjs --root <dir> --baseline <file>
 *        [--expect-sites N] [--expect-reasons in-layer=1,regex=2] [--json]
 *
 * A `--root` tree that contains a `.git` is enumerated through the SAME git
 * enumeration the real repository uses; one without is walked on the
 * filesystem. That is what lets the verification harness exercise the shipped
 * enumeration rather than a copy of it (BACKLOG-3049).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const DEFAULT_BASELINE = path.join(HERE, "sql-boundary-baseline.json");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCAN_SPEC = ["electron", "src"];
const DB_LAYER = "electron/services/db/";
const VERBS = new Set(["prepare", "exec", "pragma"]);

/**
 * NODE-SQLITE3 — a SECOND driver, taught to the gate by BACKLOG-3059.
 *
 * `VERBS` above are better-sqlite3's. This app ALSO uses node-sqlite3, whose
 * API is `.all()` / `.get()` / `.run()` / `.each()`, to read Apple's databases
 * read-only — `chat.db` and the address book. Those calls were never
 * enumerated: not classified COMPLIANT, never seen at all.
 *
 * This is a CAPABILITY THE GATE NEVER HAD, not a defect in one it claimed. The
 * NOT-ENFORCED axis A above is about aliasing THESE three verbs, and its "zero
 * instances" claim is accurate — measured 0 aliased, 0 destructured. What is
 * aliased is `.all`, which belonged to a driver the gate did not model.
 *
 * ## Enumerated by RECEIVER PROVENANCE, never by verb name
 *
 * `all`, `get`, `run` and `each` collide with `Map.get`, `Headers.get`,
 * `Promise.all`, `Array.every` and — worst — better-sqlite3's OWN
 * `statement.get`. Adding them to `VERBS` would enumerate hundreds of
 * non-database calls, and since UNRESOLVABLE is CI-blocking that turns the gate
 * red on unrelated code. BACKLOG-3044's census made exactly this mistake by
 * matching a callee NAME: 114 by name against 103 by binding, 11 collisions.
 *
 * So a site is enumerated only when its receiver is TRACEABLE to
 * `openSqliteReadOnly` — which `electron/services/db/readOnlySqlite.ts`
 * declares to be the one place node-sqlite3 is opened, and which has exactly
 * three non-test importers. Same shape as `isRegexReceiver`, inverted: there a
 * receiver proves a call is NOT SQL; here it proves that it IS.
 */
const NODE_SQLITE_VERBS = new Set(["all", "get", "run", "each"]);
const NODE_SQLITE_ANCHOR = /\bopenSqliteReadOnly\s*\(/;
const ALIAS_DEPTH_CUTOFF = 2; // see "ALIAS DEPTH AND ITS FAIL DIRECTION" above

/**
 * PERMANENT declared exceptions. These live HERE, in the script, and never in
 * the regenerable baseline JSON: `--update-baseline` rewrites that file, so an
 * exception stored there could silently promote a genuine new violation.
 * Adding an entry is a review decision. Per BACKLOG-2959 rulings 3 and 4 the
 * exception is `.pragma()`-only — connection configuration, not query text.
 * No file is exempt as a whole: these files' `.prepare()` sites are baselined.
 */
const DECLARED_EXCEPTIONS = [
  {
    file: "electron/workers/contactQueryWorker.ts",
    verb: "pragma",
    reason:
      "Worker thread opens its OWN readonly handle (:69) and must configure it " +
      "(key, cipher_compatibility, foreign_keys, busy_timeout, journal_mode). " +
      "Connection configuration, not query text. BACKLOG-2959 ruling 3.",
  },
  {
    file: "electron/services/sqliteBackupService.ts",
    verb: "pragma",
    reason:
      "Operates on a DIFFERENT database file (a backup), not the live singleton. " +
      "Cipher and connection configuration. BACKLOG-2959 ruling 4.",
  },
];

/**
 * Every baseline entry must name the item that will remove it. A baseline whose
 * entries have no owner is a permanent excuse. `UNOWNED` is not a legal value
 * and the gate rejects a baseline containing one.
 */
const OWNERS = {
  // BACKLOG-2992, re-owned FROM BACKLOG-2991 — the commit that makes the work
  // someone else's is the commit that moves the ownership. SR's D2, review
  // addendum on BACKLOG-2991, accepted by the PM.
  //
  // This line is what `--update-baseline` reads. Leaving it at 2991 while the
  // 29 JSON rows say 2992 would let the next regeneration by anyone silently
  // re-own all 38 sites back to a closed item, and the JSON edit would read as
  // the thing that had been undone.
  //
  // 2991 moved everything it should: the seven sites of PR #2484 plus the
  // `schema_version` table probe (4 sites, key `text:a73cb4792d87`) that SR
  // found half-moved — it was the guard for a statement already living in
  // `db/`. What remains is homogeneous and is item 5's class, not 2991's, and it
  // is 38 sites in 29 keys, enumerated with `--explain` rather than described:
  // 22 pragma (21 connection/maintenance + the interpolated `table_info`
  // reflection), 9 prepare (7 static `sqlite_master` reflections + the two
  // interpolated backup/restore column-list statements), and 7 `exec` of which 4
  // replay text the database itself produced and so have no authored text to
  // move. 22 + 9 + 7 = 38. BACKLOG-2992 is
  // `deferred` behind BACKLOG-2834/2836, and a deferred item is a legal
  // baseline owner — its own body already specifies exactly this model
  // ("visible, ratcheted, not silently excepted").
  //
  // File-granular is the right granularity HERE because the file is now
  // homogeneous by owner. Per-entry ownership stays the right general fix and
  // is not needed for these 29 keys.
  "electron/services/databaseService.ts": "BACKLOG-2992",
  // BACKLOG-3062, re-owned by BACKLOG-2990 chunk 5 — the commit that made the
  // work someone else's is the commit that moves the ownership.
  //
  // 2990 moved every statement it could. The SIX that remain are 3062's and
  // cannot close before it: four sit immediately after `buildMessageWindowSql(plan)`
  // and splice the window predicate as TEXT, and two are the `dbGet`/`dbAllSizes`
  // wrapper conduits those four consume. Leaving them owned by 2990 would hold a
  // finished item open against work it does not own — a false NOT-DONE, and the
  // mirror of the false DONE that 3062 was filed to name.
  //
  // `expr:4ec7c53222c8` is the same hash as `storageDiagnostics.ts:281` from
  // BACKLOG-2989: a `(sql: string) => db.verb(sql)` conduit, UNRESOLVABLE because
  // argument 0 is a parameter. Third appearance across two items, so the hash is
  // now a signature for the shape — a match on it is the conduit, without
  // re-deriving.
  "electron/services/macOSMessagesImportService/macOSMessagesImportService.ts": "BACKLOG-3062",
  "electron/services/macOSMessagesImportService/forceStaging.ts": "BACKLOG-2990",
  "electron/services/macOSMessagesImportService/importHelpers.ts": "BACKLOG-2990",
  "electron/services/iosMessagesParser.ts": "BACKLOG-2990",
  "electron/services/iosContactsParser.ts": "BACKLOG-2990",
  "electron/handlers/sessionHandlers.ts": "BACKLOG-2765",
  "electron/handlers/sharedAuthHandlers.ts": "BACKLOG-2765",
  // BACKLOG-3043. The worker's DECLARED_EXCEPTIONS entry above is `pragma`-only
  // (BACKLOG-2959 ruling 3) and never covered query text. Three of its six
  // `prepare` sites (:106, :139, :144) AUTHOR their SQL: the file imports
  // fragments from db/ and then interpolates them into a template AT THE CALL
  // SITE, which classifies LITERAL. BACKLOG-2989's brief excludes this file by
  // name, so without this line the three entries default to BACKLOG-2989 and
  // that owner can never reach zero. Naming 3043 makes the owner a decision
  // rather than a fall-through.
  "electron/workers/contactQueryWorker.ts": "BACKLOG-3043",
  // BACKLOG-3059. These two hold node-sqlite3 reads of Apple's databases and
  // are in NO item's move scope. Added in the SAME commit that teaches the gate
  // to see them: `DEFAULT_OWNER` is BACKLOG-2989, which closed at zero, so
  // enumerating them without an owner would silently re-open a finished item.
  // Exactly the contactQueryWorker.ts fall-through above, at the far end of the
  // same epic.
  "electron/handlers/conversationHandlers.ts": "BACKLOG-3059",
  "electron/services/contactsService.ts": "BACKLOG-3059",
};
const DEFAULT_OWNER = "BACKLOG-2989";
const ILLEGAL_OWNER = "UNOWNED";

const ownerFor = (file) => OWNERS[file] ?? DEFAULT_OWNER;

// ---------------------------------------------------------------------------
// Enumeration — by extension, never by glob pathspec.
//
// A `git ls-files 'electron/**/*.ts'` pathspec silently skips top-level
// `electron/*.ts` (git's `**` must span a directory), and a bare `electron/`
// pathspec pulls in non-TS files. Both traps were hit while measuring this
// item. Enumerate the file set, then filter on extension.
//
// THE WORKING TREE, NOT THE INDEX (BACKLOG-3049).
//
// This enumeration used a bare `git ls-files`, which lists TRACKED files only.
// A module that exists on disk but has never been `git add`-ed was invisible to
// the gate: measured on one tree with two new `db/` modules present, unstaged
// gave 782 sites / 123 keys and staged gave 784 / 127. Same working tree, same
// command, two answers, and the only variable was `git add`.
//
// It failed in the safe-looking direction — the baseline was unaffected, so
// nothing went red — which is exactly why it survived. The author of a brand
// new `db/*Sql.ts` ran the gate, read green, and had verified NOTHING about the
// file they had just written. A new file is when this gate has the most to say.
//
// CI never saw it: a fresh checkout is fully tracked by definition, so both
// enumerations agree there. It appeared only in the local loop, which is the
// one place an author is supposed to catch their own mistake.
//
// `--cached --others --exclude-standard` is tracked PLUS untracked-but-not-
// ignored: the set the author actually has in front of them. `.gitignore` stays
// respected, so build output, `dist/` and `node_modules` stay out — and git
// never descends into a symlinked directory, which matters here because every
// worktree symlinks `node_modules` at the main repo.
//
// The Set dedupes. `--cached` lists a path once PER STAGE during a merge
// conflict, so an unmerged tree would otherwise scan (and count) the same file
// up to three times.
// ---------------------------------------------------------------------------

const isScannable = (rel) =>
  /\.(ts|tsx)$/.test(rel) &&
  !/(^|\/)__tests__\//.test(rel) &&
  !/\.(test|spec)\.tsx?$/.test(rel);

const GIT_ENUMERATE_ARGS = [
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "--",
  ...SCAN_SPEC,
];

function enumerateRepo(root = REPO_ROOT) {
  const out = execFileSync("git", GIT_ENUMERATE_ARGS, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const rels = out.split("\n").filter(Boolean).filter(isScannable);
  return [...new Set(rels)].sort();
}

/**
 * Does `dir` hold its own git repository?
 *
 * `existsSync`, never `statSync().isDirectory()`: inside a git WORKTREE `.git`
 * is a FILE holding a `gitdir:` pointer, and a directory check would misroute
 * every worktree to the non-git enumerator. Deliberately does not walk parents
 * (`git rev-parse --git-dir` would), so a fixture tree created under a path that
 * happens to sit inside some other repository cannot silently attach to it.
 */
const isGitRoot = (dir) => existsSync(path.join(dir, ".git"));

function enumerateDir(root) {
  const found = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (isScannable(rel)) found.push(rel);
      }
    }
  })(root);
  return found.sort();
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const LITERAL_KINDS = (n) =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);

const normalize = (s) => s.replace(/\s+/g, " ").trim();
const hash12 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/**
 * All bindings for a file, each stamped with its source position, so a use can
 * resolve to the NEAREST PRECEDING declaration (A1) rather than the first.
 */
function buildBindings(sf, rel) {
  const bindings = new Map(); // name -> [{ pos, kind, init?, spec?, fromDb? }]
  const taints = []; // { name, start, end }

  const isFnLike = (p) =>
    ts.isFunctionDeclaration(p) ||
    ts.isFunctionExpression(p) ||
    ts.isArrowFunction(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isConstructorDeclaration(p);

  // The scope a node sits in: nearest enclosing function, else the file.
  const scopeOf = (n) => {
    let p = n.parent;
    while (p && !isFnLike(p) && !ts.isSourceFile(p)) p = p.parent;
    return p ?? sf;
  };

  // PASS 1 — which scope DECLARES each name.
  const declsByScope = new Map();
  const declare = (nameNode, atNode) => {
    if (!nameNode || !ts.isIdentifier(nameNode)) return;
    const sc = scopeOf(atNode);
    if (!declsByScope.has(sc)) declsByScope.set(sc, new Set());
    declsByScope.get(sc).add(nameNode.text);
  };
  (function declareAll(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) declare(n.name, n);
    if (ts.isParameter(n)) declare(n.name, n);
    if (ts.isBindingElement(n)) declare(n.name, n);
    if (ts.isCatchClause(n) && n.variableDeclaration) declare(n.variableDeclaration.name, n);
    if (ts.isFunctionDeclaration(n) && n.name) declare(n.name, n);
    if (ts.isClassDeclaration(n) && n.name) declare(n.name, n);
    if (ts.isImportSpecifier(n)) declare(n.name, n);
    if (ts.isImportClause(n) && n.name) declare(n.name, n);
    if (ts.isNamespaceImport(n)) declare(n.name, n);
    ts.forEachChild(n, declareAll);
  })(sf);

  // The scope that declares `name`, seen from `fromNode`: walk outward until a
  // scope claims it, else the file. An undeclared/global write taints file-wide,
  // which is the fail-closed direction.
  const declaringScope = (name, fromNode) => {
    let sc = scopeOf(fromNode);
    for (;;) {
      if (declsByScope.get(sc)?.has(name)) return sc;
      if (ts.isSourceFile(sc)) return sf;
      sc = scopeOf(sc);
    }
  };

  // TAINT (BACKLOG-2959 amendment A5).
  //
  // This map models exactly two binding forms: a declaration with an
  // initializer, and a named import. A name written or bound by any OTHER form
  // — assignment, `+=`, parameter, destructuring, catch variable, uninitialised
  // `let` — is invisible to it, so `nearestPreceding` would skip the write and
  // resolve the use to the modelled declaration above it. That greens
  // interpolated SQL:
  //
  //     let sql = <db import>;
  //     sql += ` LIMIT ${n}`;      // invisible
  //     db.prepare(sql);           // resolved to the import -> COMPLIANT
  //
  // and it is not exotic: `let sql = ...; sql += ...` is the dominant
  // query-assembly idiom inside electron/services/db/ itself. Left unfixed it
  // produces a false DONE on the very remediation this gate protects — a
  // half-move of iosMessagesParser.ts:674 (BACKLOG-2990) drops its baseline
  // entry to zero while the file still authors `LIMIT ${...}` outside db/.
  //
  // So: a name with an unmodelled write cannot yield a COMPLIANT verdict
  // anywhere in the scope that DECLARES it.
  //
  // The span is the declaring scope, not a syntactic position around the write.
  // Approximating it by position is wrong in two directions, and both happened:
  //
  //   innermost function around the write -> TOO NARROW. A write inside a
  //     callback tainted only the callback, while the name it mutates is
  //     declared and read outside it:
  //         let sql = <db import>;
  //         filters.forEach((f) => { sql += ` AND ${f} = ?`; });
  //         db.prepare(sql);                     // was COMPLIANT
  //
  //   outermost function around the write -> STILL TOO NARROW for a
  //     module-scoped name, and TOO WIDE for sibling closures:
  //         let cachedSql = <db import>;         // declared at module scope
  //         export function configure(t) { cachedSql = `... ${t}`; }
  //         export function run(db) { db.prepare(cachedSql); }   // was COMPLIANT
  //
  // The property being protected — "this name may hold something the model
  // cannot see" — belongs to the BINDING. So the span IS the binding's scope.
  // That closes both directions at once, and removes the sibling-closure false
  // red the outermost rule introduced: a scope that declares its own binding is
  // never tainted by a write to a same-named binding elsewhere.
  const taint = (nm, at) => {
    if (!nm || !ts.isIdentifier(nm)) return;
    const scope = declaringScope(nm.text, at);
    taints.push({ name: nm.text, start: scope.getStart(sf), end: scope.getEnd() });
  };

  const add = (name, entry) => {
    if (!bindings.has(name)) bindings.set(name, []);
    bindings.get(name).push(entry);
  };
  const fromDbLayer = (spec) => {
    if (!spec.startsWith(".")) return false;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    return resolved.startsWith(DB_LAYER);
  };
  (function collect(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      add(n.name.text, { pos: n.getStart(sf), kind: "var", init: n.initializer });
    }
    if (
      ts.isImportDeclaration(n) &&
      n.importClause?.namedBindings &&
      ts.isNamedImports(n.importClause.namedBindings) &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      const spec = n.moduleSpecifier.text;
      for (const el of n.importClause.namedBindings.elements) {
        add(el.name.text, {
          pos: n.getStart(sf),
          kind: "import",
          spec,
          imported: (el.propertyName ?? el.name).text,
          fromDb: fromDbLayer(spec),
        });
      }
    }
    if (
      ts.isBinaryExpression(n) &&
      ts.isIdentifier(n.left) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) taint(n.left, n);
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && ts.isIdentifier(n.operand))
      taint(n.operand, n);
    if (ts.isParameter(n)) taint(n.name, n);
    if (ts.isBindingElement(n)) taint(n.name, n);
    if (ts.isCatchClause(n) && n.variableDeclaration) taint(n.variableDeclaration.name, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && !n.initializer) taint(n.name, n);
    ts.forEachChild(n, collect);
  })(sf);
  return { bindings, taints };
}

const isTainted = (taints, name, usePos) =>
  taints.some((t) => t.name === name && usePos >= t.start && usePos <= t.end);

const nearestPreceding = (bindings, name, usePos) => {
  const list = bindings.get(name);
  if (!list) return null;
  let best = null;
  for (const b of list) if (b.pos < usePos && (!best || b.pos > best.pos)) best = b;
  return best;
};

/**
 * Returns { tag, node, importRef? }.
 *   LITERAL             SQL text authored in this file
 *   FROM_DB             text originates in electron/services/db/**
 *   IMPORTED_ELSEWHERE  text imported from a non-db module (A4)
 *   UNRESOLVABLE        origin not statically determinable
 */
function classifyArg(node, depth, usePos, ctx) {
  if (!node) return { tag: "UNRESOLVABLE", node: null };
  if (ts.isParenthesizedExpression(node)) return classifyArg(node.expression, depth, usePos, ctx);
  if (LITERAL_KINDS(node)) return { tag: "LITERAL", node };

  if (ts.isBinaryExpression(node) || ts.isConditionalExpression(node)) {
    const [a, b] = ts.isBinaryExpression(node)
      ? [node.left, node.right]
      : [node.whenTrue, node.whenFalse];
    const l = classifyArg(a, depth, usePos, ctx);
    const r = classifyArg(b, depth, usePos, ctx);
    if (l.tag === "LITERAL" || r.tag === "LITERAL") return { tag: "LITERAL", node };
    if (l.tag === "IMPORTED_ELSEWHERE") return l;
    if (r.tag === "IMPORTED_ELSEWHERE") return r;
    if (l.tag === "FROM_DB" && r.tag === "FROM_DB") return { tag: "FROM_DB", node };
    return { tag: "UNRESOLVABLE", node };
  }

  if (ts.isIdentifier(node)) {
    if (depth >= ALIAS_DEPTH_CUTOFF) return { tag: "UNRESOLVABLE", node };
    const b = nearestPreceding(ctx.bindings, node.text, usePos);
    if (!b) return { tag: "UNRESOLVABLE", node };
    // Deliberate asymmetry: taint downgrades only FROM_DB. A name resolving to a
    // LITERAL must keep classifying as LITERAL so its `text:` key — and its
    // baseline entry — are preserved. Tainting that path would move the baseline.
    const tainted = isTainted(ctx.taints, node.text, usePos);
    if (b.kind === "import") {
      if (b.fromDb) return tainted ? { tag: "UNRESOLVABLE", node } : { tag: "FROM_DB", node };
      return { tag: "IMPORTED_ELSEWHERE", node, importRef: `import:${b.spec}#${b.imported}` };
    }
    const resolved = classifyArg(b.init, depth + 1, b.init.getStart(ctx.sf), ctx);
    return tainted && resolved.tag === "FROM_DB" ? { tag: "UNRESOLVABLE", node } : resolved;
  }

  // Calls, parameters, property access, element access, await, etc.
  return { tag: "UNRESOLVABLE", node };
}

/**
 * A RegExp receiver is POSITIVE proof the call is not a database call.
 * Only `.exec()` is ambiguous — `.prepare()` and `.pragma()` do not exist on
 * RegExp. Accepts both a regex literal and `new RegExp(...)`; the latter is
 * what electron/services/llm/contentSanitizer.ts:138 uses.
 */
function isRegexReceiver(node, ctx) {
  if (ts.isRegularExpressionLiteral(node)) return true;
  if (!ts.isIdentifier(node)) return false;
  // Taint applies at BOTH call sites of nearestPreceding, not just classifyArg.
  // A reassigned regex variable would otherwise keep greening `.exec()`:
  //   let r = /^abc$/; r = db; r.exec(`DELETE FROM t WHERE id = '${id}'`);
  // The whole point of taint is that a name the model cannot track is never a
  // positive proof — including the proof that a call is not a database call.
  if (isTainted(ctx.taints, node.text, node.getStart(ctx.sf))) return false;
  const b = nearestPreceding(ctx.bindings, node.text, node.getStart(ctx.sf));
  if (!b || b.kind !== "var") return false;
  const init = b.init;
  if (ts.isRegularExpressionLiteral(init)) return true;
  return ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "RegExp";
}

const isDeclaredException = (file, verb) =>
  DECLARED_EXCEPTIONS.find((e) => e.file === file && e.verb === verb) ?? null;

/**
 * Names that hold a node-sqlite3 handle, and names that alias one of its verbs.
 *
 * Resolved to a FIXPOINT over the cross-product of binding forms:
 *
 *     { declaration, assignment } x { direct openSqliteReadOnly, wrapper call }
 *
 * Every one of those four corners exists in the tree today, and patching them
 * one at a time is how the hand-written census that preceded this was wrong
 * four times running:
 *
 *     const db  = await openSqliteReadOnly(...)          declaration + direct
 *     db2       = await openSqliteReadOnly(...)          assignment  + direct
 *     const h   = openAddressBookReadOnly(path)          declaration + wrapper
 *     db        = await openAddressBookReadOnly(path)    assignment  + wrapper
 *
 * A wrapper is any function whose body mentions the anchor. The loop repeats
 * until nothing new is found, so a wrapper around a wrapper resolves too.
 */
function buildNodeSqliteBindings(sf) {
  const handles = new Set();
  const wrappers = new Set();
  const aliases = new Map(); // name -> the verb it wraps

  const nameOf = (n) => (n && ts.isIdentifier(n) ? n.text : null);

  // Pass 1: functions that hand back a handle.
  (function w(n) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && n.body &&
        NODE_SQLITE_ANCHOR.test(n.body.getText(sf)))
      wrappers.add(n.name.getText(sf));
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) &&
        NODE_SQLITE_ANCHOR.test(n.initializer.getText(sf)))
      wrappers.add(n.name.text);
    ts.forEachChild(n, w);
  })(sf);

  // Pass 2: handles, to a fixpoint over both binding forms and both sources.
  const acquires = (text) => {
    if (NODE_SQLITE_ANCHOR.test(text)) return true;
    for (const wr of wrappers) if (new RegExp(`\\b${wr}\\s*\\(`).test(text)) return true;
    return false;
  };
  let grew = true;
  while (grew) {
    grew = false;
    (function w(n) {
      let name = null, init = null;
      if (ts.isVariableDeclaration(n)) { name = nameOf(n.name); init = n.initializer; }
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        name = nameOf(n.left); init = n.right;
      }
      if (name && init && !handles.has(name) && acquires(init.getText(sf))) {
        handles.add(name);
        grew = true;
      }
      ts.forEachChild(n, w);
    })(sf);
  }

  // Pass 3: `const dbAll = handle.all` — a METHOD REFERENCE, not a call.
  (function w(n) {
    let name = null, init = null;
    if (ts.isVariableDeclaration(n)) { name = nameOf(n.name); init = n.initializer; }
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      name = nameOf(n.left); init = n.right;
    }
    if (name && init && ts.isPropertyAccessExpression(init) &&
        NODE_SQLITE_VERBS.has(init.name.text) && ts.isIdentifier(init.expression) &&
        handles.has(init.expression.text))
      aliases.set(name, init.name.text);
    // and `const dbGet = (sql) => handle.get(sql)` — a wrapper around one verb.
    // The verb is READ OFF the body, never assumed: an earlier revision
    // hardcoded "all" here and mislabelled every `dbGet()` site, which would
    // have written a wrong verb into the baseline key.
    if (name && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      const body = init.getText(sf);
      for (const h of handles) {
        const m = new RegExp(`\\b${h}\\.(all|get|run|each)\\s*[(<]`).exec(body);
        if (m) { aliases.set(name, m[1]); break; }
      }
    }
    ts.forEachChild(n, w);
  })(sf);

  return { handles, aliases };
}

function scanFile(rel, source) {
  const sf = ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  // PR-SOP 6.4: a file the guard cannot parse is a file it cannot vouch for.
  // A swallowed parse error is indistinguishable from a clean file.
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length) {
    const first = ts.flattenDiagnosticMessageText(diags[0].messageText, " ");
    throw new Error(`cannot parse ${rel}: ${diags.length} parse diagnostic(s); first: ${first}`);
  }

  const bound = buildBindings(sf, rel);
  const ctx = { sf, bindings: bound.bindings, taints: bound.taints };
  const nodeSql = buildNodeSqliteBindings(sf);
  const inDb = rel.startsWith(DB_LAYER);
  const sites = [];

  // LAYER INTEGRITY.
  //
  // `from-db-import` is a positive proof that the SQL text ORIGINATES in the db
  // layer, but `fromDbLayer()` only resolves one hop and asks where the module
  // SITS. A two-line barrel inside the layer launders text defined outside it:
  //
  //     // electron/services/db/barrel.ts
  //     export { EVIL_SQL } from "../../handlers/evilSql";
  //     export * from "../../handlers/evilSql";
  //
  // every importer of `db/barrel` then reads COMPLIANT from-db-import.
  //
  // The finding is raised AT THE BARREL, not at the importer: the PR that
  // creates the laundering fails, and no legitimate in-layer import is
  // punished for someone else's re-export. Type-only re-exports are exempt —
  // a type carries no runtime string. This is not a call site, so it is
  // reported separately and never enters the three-bucket census.
  const layerFindings = [];
  if (inDb) {
    for (const st of sf.statements) {
      if (!ts.isExportDeclaration(st) || !st.moduleSpecifier) continue;
      if (st.isTypeOnly) continue;
      if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;
      const resolved = spec.startsWith(".")
        ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
        : null; // bare specifier: resolves into node_modules, i.e. outside db/
      if (resolved !== null && resolved.startsWith(DB_LAYER)) continue; // inward, fine
      layerFindings.push({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1,
        verb: "reexport",
        bucket: "VIOLATION",
        reason: "db-layer-re-exports-text-defined-outside",
        match: `reexport:${spec}`,
      });
    }
  }

  /** Same classification a better-sqlite3 site gets; only enumeration differs. */
  const classifyNodeSqlSite = (n, verb) => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const site = { file: rel, line, verb, receiver: "node-sqlite3" };
    if (inDb) {
      Object.assign(site, { bucket: "COMPLIANT", reason: "in-layer" });
    } else {
      const arg0 = n.arguments[0];
      const c = classifyArg(arg0, 0, n.getStart(sf), ctx);
      if (c.tag === "FROM_DB") Object.assign(site, { bucket: "COMPLIANT", reason: "from-db-import" });
      else if (c.tag === "LITERAL")
        Object.assign(site, {
          bucket: "VIOLATION",
          reason: "sql-text-authored-outside-db-layer",
          match: `text:${hash12(normalize(c.node.getText(sf)))}`,
        });
      else if (c.tag === "IMPORTED_ELSEWHERE")
        Object.assign(site, { bucket: "VIOLATION", reason: "sql-text-imported-from-non-db-module", match: c.importRef });
      else
        Object.assign(site, {
          bucket: "UNRESOLVABLE",
          reason: "origin-not-statically-determinable",
          match: `expr:${hash12(normalize(arg0 ? arg0.getText(sf) : "<no-argument>"))}`,
        });
    }
    sites.push(site);
  };

  (function walk(n) {
    // node-sqlite3, enumerated by RECEIVER PROVENANCE (BACKLOG-3059).
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isPropertyAccessExpression(e) && NODE_SQLITE_VERBS.has(e.name.text) &&
          ts.isIdentifier(e.expression) && nodeSql.handles.has(e.expression.text)) {
        classifyNodeSqlSite(n, e.name.text);
      } else if (ts.isIdentifier(e) && nodeSql.aliases.has(e.text)) {
        classifyNodeSqlSite(n, nodeSql.aliases.get(e.text));
      }
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const verb = n.expression.name.text;
      if (VERBS.has(verb)) {
        const recv = n.expression.expression;
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        const site = { file: rel, line, verb, receiver: normalize(recv.getText(sf)).slice(-40) };

        const exc = isDeclaredException(rel, verb);
        if (verb === "exec" && isRegexReceiver(recv, ctx)) {
          Object.assign(site, { bucket: "COMPLIANT", reason: "regex" });
        } else if (inDb) {
          Object.assign(site, { bucket: "COMPLIANT", reason: "in-layer" });
        } else if (exc) {
          Object.assign(site, { bucket: "COMPLIANT", reason: "declared-exception", note: exc.reason });
        } else {
          const arg0 = n.arguments[0];
          const c = classifyArg(arg0, 0, n.getStart(sf), ctx);
          if (c.tag === "FROM_DB") {
            Object.assign(site, { bucket: "COMPLIANT", reason: "from-db-import" });
          } else if (c.tag === "LITERAL") {
            Object.assign(site, {
              bucket: "VIOLATION",
              reason: "sql-text-authored-outside-db-layer",
              match: `text:${hash12(normalize(c.node.getText(sf)))}`,
            });
          } else if (c.tag === "IMPORTED_ELSEWHERE") {
            Object.assign(site, {
              bucket: "VIOLATION",
              reason: "sql-text-imported-from-non-db-module",
              match: c.importRef,
            });
          } else {
            Object.assign(site, {
              bucket: "UNRESOLVABLE",
              reason: "origin-not-statically-determinable",
              match: `expr:${hash12(normalize(arg0 ? arg0.getText(sf) : "<no-argument>"))}`,
            });
          }
        }
        sites.push(site);
      }
    }
    ts.forEachChild(n, walk);
  })(sf);

  return { sites, layerFindings };
}

// ---------------------------------------------------------------------------
// Baseline — identity-keyed, never counted.
//
// A per-file count lets a file swap one query for another and stay green. The
// precedent this follows (scripts/ci/check-fixture-pii.mjs:921) keys on
// file :: rule :: match for exactly that reason.
// ---------------------------------------------------------------------------

const keyOf = (e) => `${e.file} :: ${e.verb} :: ${e.match}`;

function baselineEligible(sites) {
  return sites.filter((s) => s.bucket === "VIOLATION" || s.bucket === "UNRESOLVABLE");
}

function buildEntries(eligible) {
  const seen = new Map();
  for (const s of eligible) {
    const k = keyOf(s);
    if (seen.has(k)) seen.get(k).count += 1;
    else
      seen.set(k, {
        file: s.file,
        verb: s.verb,
        match: s.match,
        bucket: s.bucket,
        count: 1,
        owner: ownerFor(s.file),
      });
  }
  return [...seen.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.verb.localeCompare(b.verb) || a.match.localeCompare(b.match)
  );
}

const BASELINE_COMMENT =
  "Sites where SQL text is defined outside electron/services/db/**, recorded so " +
  "scripts/ci/check-sql-boundary.mjs fails only on NEW ones. Every entry names the " +
  "backlog item that will remove it. Entries only ratchet DOWN: an entry leaves this " +
  "file when its SQL moves into db/**, never by being deleted to silence the gate, and " +
  "never by regenerating after adding a violation: --update-baseline refuses to record ANY " +
  "key absent from the current baseline (not merely a grown total, which a swap would slip " +
  "past) unless given --allow-growth. Removing keys never needs a flag. " +
  "owner:UNOWNED is not a legal value.";

function loadBaseline(file) {
  if (!existsSync(file)) return { entries: [], map: new Map(), missing: true };
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const map = new Map();
  for (const e of raw.entries ?? []) map.set(keyOf(e), e);
  return { entries: raw.entries ?? [], map, meta: raw, missing: false };
}

function writeBaseline(file, entries, measuredAt) {
  const total = entries.reduce((n, e) => n + e.count, 0);
  writeFileSync(
    file,
    JSON.stringify(
      {
        $comment: BASELINE_COMMENT,
        generatedBy: "node scripts/ci/check-sql-boundary.mjs --update-baseline",
        backlog: "BACKLOG-2959",
        measuredAt,
        totalSites: total,
        entryCount: entries.length,
        entries,
      },
      null,
      2
    ) + "\n"
  );
  return total;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    explain: false, update: false, allowGrowth: false, json: false,
    root: null, baseline: null, expectSites: null, expectReasons: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--explain") a.explain = true;
    else if (v === "--update-baseline") a.update = true;
    else if (v === "--allow-growth") a.allowGrowth = true;
    else if (v === "--json") a.json = true;
    else if (v === "--root") a.root = argv[++i];
    else if (v === "--baseline") a.baseline = argv[++i];
    else if (v === "--expect-sites") a.expectSites = Number(argv[++i]);
    else if (v === "--expect-reasons") a.expectReasons = argv[++i];
    else {
      console.error(`unknown argument: ${v}`);
      process.exit(2);
    }
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ? path.resolve(args.root) : REPO_ROOT;
  const baselineFile = args.baseline ? path.resolve(args.baseline) : DEFAULT_BASELINE;
  const fixtureMode = Boolean(args.root);

  // A fixture tree that IS a git repo is enumerated through the REAL
  // `enumerateRepo`, so the harness can exercise the git enumeration itself
  // rather than a copy of it (BACKLOG-3049). Non-git fixture trees — every
  // pre-existing control — keep the plain filesystem walk.
  const files = fixtureMode
    ? isGitRoot(root)
      ? enumerateRepo(root)
      : enumerateDir(root)
    : enumerateRepo(REPO_ROOT);

  const sites = [];
  const layerFindings = [];
  for (const rel of files) {
    let source;
    try {
      source = readFileSync(path.join(root, rel), "utf8");
    } catch (err) {
      // A file the guard cannot read is a file it cannot vouch for.
      console.error(`FATAL: cannot read ${rel}: ${err.message}`);
      process.exit(2);
    }
    try {
      const scanned = scanFile(rel, source);
      sites.push(...scanned.sites);
      layerFindings.push(...scanned.layerFindings);
    } catch (err) {
      console.error(`FATAL: ${err.message}`);
      process.exit(2);
    }
  }

  const compliant = sites.filter((s) => s.bucket === "COMPLIANT");
  const violations = sites.filter((s) => s.bucket === "VIOLATION");
  const unresolvable = sites.filter((s) => s.bucket === "UNRESOLVABLE");

  // NO-FOURTH-BUCKET GUARD.
  //
  // This is NOT a completeness check and must not be described as one: every
  // site is assigned exactly one bucket in an exhaustive branch before being
  // pushed, so both sides move together and a skipped FILE contributes zero to
  // each. What it does catch is a fourth bucket label being introduced.
  // Detecting skipped input is the job of --expect-sites on a fixture tree of
  // known contents, and of baseline ratchet rule 2 on the real tree.
  const bucketSum = compliant.length + violations.length + unresolvable.length;
  if (bucketSum !== sites.length) {
    console.error(
      `FATAL: no-fourth-bucket guard failed: ${compliant.length}+${violations.length}+` +
        `${unresolvable.length} = ${bucketSum} but ${sites.length} sites were enumerated. ` +
        `A site carries a bucket label outside {COMPLIANT, VIOLATION, UNRESOLVABLE}.`
    );
    process.exit(2);
  }

  const reasonCensus = {};
  for (const s of compliant) reasonCensus[s.reason] = (reasonCensus[s.reason] ?? 0) + 1;

  const eligible = [...baselineEligible(sites), ...layerFindings];
  const entries = buildEntries(eligible);
  const currentTotal = eligible.length;

  // --- fixture-tree assertions (A3) ---------------------------------------
  // Absolute counts are asserted ONLY on fixture trees, whose contents are
  // fixed and known. They are never asserted on the real tree: `in-layer` is
  // designed to climb from 123 toward 310 as BACKLOG-2989/2990/2991 land, so a
  // real-tree census assertion would red-bar the remediation this gate exists
  // to support. The real tree PRINTS its numbers instead.
  let assertionFailed = false;
  if (args.expectSites !== null) {
    if (sites.length !== args.expectSites) {
      console.error(`ASSERTION FAILED: expected ${args.expectSites} call sites, enumerated ${sites.length}.`);
      assertionFailed = true;
    }
  }
  if (args.expectReasons) {
    for (const pair of args.expectReasons.split(",").filter(Boolean)) {
      const [name, want] = pair.split("=");
      const got = reasonCensus[name] ?? 0;
      if (got !== Number(want)) {
        console.error(`ASSERTION FAILED: COMPLIANT reason "${name}" expected ${want}, got ${got}.`);
        assertionFailed = true;
      }
    }
  }

  // --- report --------------------------------------------------------------
  const report = {
    enumeratedFiles: files.length,
    callSites: sites.length,
    compliant: compliant.length,
    violation: violations.length,
    unresolvable: unresolvable.length,
    baselineEligible: currentTotal,
    layerIntegrity: layerFindings.length,
    complianceReasons: reasonCensus,
  };

  // In --json mode stdout carries the JSON document and nothing else; all
  // human-readable output goes to stderr so callers can parse stdout directly.
  const say = args.json ? (...a) => console.error(...a) : (...a) => console.log(...a);

  if (args.json) console.log(JSON.stringify(report, null, 2));
  say("SQL boundary gate — SQL text belongs in electron/services/db/**");
  say(`  files enumerated   ${report.enumeratedFiles}`);
  say(`  call sites         ${report.callSites}`);
  say(`  COMPLIANT          ${report.compliant}  ${JSON.stringify(reasonCensus)}`);
  say(`  VIOLATION          ${report.violation}`);
  say(`  UNRESOLVABLE       ${report.unresolvable}  (counts as a violation)`);
  say(`  layer integrity    ${report.layerIntegrity} re-export(s) of text defined outside ${DB_LAYER}`);
  say(`  baseline-eligible  ${report.baselineEligible} in ${entries.length} distinct keys`);

  if (args.explain) {
    say("\nPer-site classification:");
    for (const s of [...sites, ...layerFindings]) {
      const tail = s.match ? `  ${s.match}` : "";
      say(`  ${s.bucket.padEnd(13)} ${s.reason.padEnd(38)} ${s.verb.padEnd(8)} ${s.file}:${s.line}${tail}`);
    }
    say(
      "\nAlias depth cutoff is " + ALIAS_DEPTH_CUTOFF + ". Beyond it the classifier returns " +
        "UNRESOLVABLE, which counts as a violation — exceeding the cutoff can only produce a " +
        "false RED, never a false green.\n" +
        "A name written by a form the binding map does not model (assignment, +=, parameter, " +
        "destructuring, catch variable, uninitialised let) is tainted for THE SCOPE THAT " +
        "DECLARES IT, and cannot be COMPLIANT. The span is the binding's scope, not a " +
        "position around the write, so it covers every read of that binding.\n" +
        "Classifier limits, all fail-closed (false red, never false green): interprocedural " +
        "flow is not modelled — SQL passed into a helper is reported UNRESOLVABLE, which means " +
        "the gate cannot trace the origin, NOT that the site is certified; and taint is " +
        "scope-exact but not flow-exact.\n" +
        "`from-db-import` means the text originates in the layer: a db/ file re-exporting " +
        "from outside db/ is itself a VIOLATION, raised at the barrel, so no importer can " +
        "inherit a proof the layer does not have.\n" +
        "Not enforced at all — a different guarantee: computed/bound/destructured calls " +
        "(db[\"prepare\"](...), .bind, const { prepare } = db) are never ENUMERATED, and only " +
        ".ts/.tsx files are scanned. Zero instances of either in the tree today."
    );
  }

  // --- update mode ---------------------------------------------------------
  if (args.update) {
    const prior = loadBaseline(baselineFile);
    // Refuse any key ABSENT from the prior baseline -- not merely a grown total.
    // A total-based guard lets a swap through: remove one baselined query, add a
    // brand-new one, and the count is unchanged so regeneration succeeds
    // silently. Removing keys is always allowed, so the ratchet-down path is
    // untouched: that is the whole point of this file.
    const priorKeys = prior.missing ? null : new Set(prior.entries.map(keyOf));
    const brandNew = priorKeys ? entries.filter((e) => !priorKeys.has(keyOf(e))) : [];
    if (brandNew.length && !args.allowGrowth) {
      console.error(
        `\nREFUSING to record ${brandNew.length} key(s) absent from the current baseline:`
      );
      for (const e of brandNew.slice(0, 20)) console.error(`  ${keyOf(e)}`);
      console.error(
        `\nRegenerating after ADDING a violation is how a gate is quietly switched off,\n` +
          `and swapping one query for another keeps the total unchanged.\n` +
          `Move the SQL into ${DB_LAYER}, or pass --allow-growth with a reviewed reason.\n` +
          `(Removing keys never needs a flag — ratcheting down is always allowed.)`
      );
      process.exit(1);
    }
    const total = writeBaseline(baselineFile, entries, fixtureMode ? "fixture" : currentSha());
    say(`\nbaseline written: ${entries.length} keys, ${total} sites -> ${path.relative(root, baselineFile)}`);
    process.exit(assertionFailed ? 1 : 0);
  }

  // --- compare mode --------------------------------------------------------
  const baseline = loadBaseline(baselineFile);
  if (baseline.missing) {
    console.error(`\nFATAL: no baseline at ${baselineFile}. Generate it with --update-baseline.`);
    process.exit(2);
  }

  const illegal = baseline.entries.filter((e) => !e.owner || e.owner === ILLEGAL_OWNER);
  const currentKeys = new Map(entries.map((e) => [keyOf(e), e]));

  // Rule 1 — a violation key absent from the baseline is RED.
  const added = [...currentKeys.values()].filter((e) => !baseline.map.has(keyOf(e)));
  // Rule 2 — a baseline key with no matching violation is RED (stale; delete it).
  // This also catches enumeration regressions over baselined files: a silently
  // skipped file yields no violations, so all of its keys read as stale.
  const stale = baseline.entries.filter((e) => !currentKeys.has(keyOf(e)));
  // A key whose occurrence count grew is RED.
  const grew = [...currentKeys.values()].filter((e) => {
    const b = baseline.map.get(keyOf(e));
    return b && e.count > b.count;
  });

  let failed = assertionFailed;

  if (illegal.length) {
    failed = true;
    console.error(`\n${illegal.length} baseline entr(ies) have no owner. "${ILLEGAL_OWNER}" is not legal:`);
    for (const e of illegal.slice(0, 20)) console.error(`  ${keyOf(e)}`);
  }
  if (added.length) {
    failed = true;
    console.error(`\n${added.length} NEW SQL site(s) outside ${DB_LAYER}:`);
    for (const e of added.slice(0, 40)) {
      const where = [...sites, ...layerFindings].find((s) => keyOf(s) === keyOf(e));
      console.error(`  ${e.file}:${where ? where.line : "?"}  ${e.verb}  [${e.bucket}]  ${e.match}`);
    }
    if (added.some((e) => e.verb === "reexport")) {
      console.error(
        `\nA re-export above sends text DEFINED OUTSIDE ${DB_LAYER} back out through the ` +
          `layer, which would make every importer read as compliant on a proof it does not ` +
          `have. Move the declaration into ${DB_LAYER} instead of re-exporting it.`
      );
    }
    console.error(
      `\nDefine the SQL text in ${DB_LAYER} (the *Sql.ts pattern) and import it. ` +
        `An UNRESOLVABLE site means the gate cannot trace where the text came from — ` +
        `passing SQL through a helper parameter is itself what the rule prevents. ` +
        `Run with --explain to see each site's classification.`
    );
  }
  if (grew.length) {
    failed = true;
    console.error(`\n${grew.length} baseline key(s) gained occurrences:`);
    for (const e of grew.slice(0, 20)) console.error(`  ${keyOf(e)}  ${baseline.map.get(keyOf(e)).count} -> ${e.count}`);
  }
  if (stale.length) {
    failed = true;
    console.error(`\n${stale.length} baseline key(s) no longer match anything — ratchet them down:`);
    for (const e of stale.slice(0, 40)) console.error(`  ${keyOf(e)}  (owner ${e.owner})`);
    console.error(`\nIf you moved this SQL into ${DB_LAYER}, run --update-baseline in the SAME commit.`);
  }

  if (failed) process.exit(1);
  say("\nOK — no SQL text defined outside the db layer beyond the recorded baseline.");
  process.exit(0);
}

function currentSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

main();
