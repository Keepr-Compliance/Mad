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
 * KNOWN LIMIT
 *   Resolution does not cross a function boundary, so SQL arriving as a
 *   parameter is UNRESOLVABLE — reported as a violation, not silently passed.
 *
 * USAGE
 *   node scripts/ci/check-sql-boundary.mjs
 *   node scripts/ci/check-sql-boundary.mjs --explain
 *   node scripts/ci/check-sql-boundary.mjs --update-baseline [--allow-growth]
 *   node scripts/ci/check-sql-boundary.mjs --root <dir> --baseline <file>
 *        [--expect-sites N] [--expect-reasons in-layer=1,regex=2] [--json]
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
  "electron/services/databaseService.ts": "BACKLOG-2991",
  "electron/services/macOSMessagesImportService/macOSMessagesImportService.ts": "BACKLOG-2990",
  "electron/services/macOSMessagesImportService/forceStaging.ts": "BACKLOG-2990",
  "electron/services/macOSMessagesImportService/importHelpers.ts": "BACKLOG-2990",
  "electron/services/iosMessagesParser.ts": "BACKLOG-2990",
  "electron/services/iosContactsParser.ts": "BACKLOG-2990",
  "electron/handlers/sessionHandlers.ts": "BACKLOG-2765",
  "electron/handlers/sharedAuthHandlers.ts": "BACKLOG-2765",
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
// item. Enumerate the tracked set, then filter on extension.
// ---------------------------------------------------------------------------

const isScannable = (rel) =>
  /\.(ts|tsx)$/.test(rel) &&
  !/(^|\/)__tests__\//.test(rel) &&
  !/\.(test|spec)\.tsx?$/.test(rel);

function enumerateRepo() {
  const out = execFileSync("git", ["ls-files", "--", ...SCAN_SPEC], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\n").filter(Boolean).filter(isScannable).sort();
}

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
    ts.forEachChild(n, collect);
  })(sf);
  return bindings;
}

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
    if (b.kind === "import") {
      return b.fromDb
        ? { tag: "FROM_DB", node }
        : { tag: "IMPORTED_ELSEWHERE", node, importRef: `import:${b.spec}#${b.imported}` };
    }
    return classifyArg(b.init, depth + 1, b.init.getStart(ctx.sf), ctx);
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
  const b = nearestPreceding(ctx.bindings, node.text, node.getStart(ctx.sf));
  if (!b || b.kind !== "var") return false;
  const init = b.init;
  if (ts.isRegularExpressionLiteral(init)) return true;
  return ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "RegExp";
}

const isDeclaredException = (file, verb) =>
  DECLARED_EXCEPTIONS.find((e) => e.file === file && e.verb === verb) ?? null;

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

  const ctx = { sf, bindings: buildBindings(sf, rel) };
  const inDb = rel.startsWith(DB_LAYER);
  const sites = [];

  (function walk(n) {
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

  return sites;
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

function buildEntries(sites) {
  const seen = new Map();
  for (const s of baselineEligible(sites)) {
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
  "never by regenerating after adding a violation (--update-baseline refuses to grow " +
  "without --allow-growth). owner:UNOWNED is not a legal value.";

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

  const files = fixtureMode ? enumerateDir(root) : enumerateRepo();

  const sites = [];
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
      sites.push(...scanFile(rel, source));
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

  const eligible = baselineEligible(sites);
  const entries = buildEntries(sites);
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
  say(`  baseline-eligible  ${report.baselineEligible} in ${entries.length} distinct keys`);

  if (args.explain) {
    say("\nPer-site classification:");
    for (const s of sites) {
      const tail = s.match ? `  ${s.match}` : "";
      say(`  ${s.bucket.padEnd(13)} ${s.reason.padEnd(38)} ${s.verb.padEnd(8)} ${s.file}:${s.line}${tail}`);
    }
    say(
      "\nAlias depth cutoff is " + ALIAS_DEPTH_CUTOFF + ". Beyond it the classifier returns " +
        "UNRESOLVABLE, which counts as a violation — exceeding the cutoff can only produce a " +
        "false RED, never a false green. SQL arriving as a function parameter is UNRESOLVABLE " +
        "by the same rule: resolution does not cross a function boundary."
    );
  }

  // --- update mode ---------------------------------------------------------
  if (args.update) {
    const prior = loadBaseline(baselineFile);
    const priorTotal = prior.missing ? 0 : (prior.meta.totalSites ?? 0);
    if (!prior.missing && currentTotal > priorTotal && !args.allowGrowth) {
      console.error(
        `\nREFUSING to grow the baseline: ${priorTotal} -> ${currentTotal}.\n` +
          `Regenerating after ADDING a violation is how a gate is quietly switched off.\n` +
          `Move the SQL into ${DB_LAYER}, or pass --allow-growth with a reviewed reason.`
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
      const where = sites.find((s) => keyOf(s) === keyOf(e));
      console.error(`  ${e.file}:${where ? where.line : "?"}  ${e.verb}  [${e.bucket}]  ${e.match}`);
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
