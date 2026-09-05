#!/usr/bin/env node
/**
 * BACKLOG-3044 — the move control: SQL text must survive a move byte-identically.
 *
 * ## Why this is not BACKLOG-3064's control
 *
 * 3064 WRAPPED statements where they stood, so its control could key each slice by
 * `file#ordinal` and diff position by position. This item MOVES statements between
 * files, so `file#ordinal` is meaningless on the "after" side: the statement is not
 * in that file any more, and every ordinal after it has shifted.
 *
 * So the key here is the TEXT ITSELF. For each statement we take the COOKED value —
 * what the JavaScript engine hands to SQLite, not the source slice — and hash it.
 * Cooked, not source, because the move legitimately changes the QUOTING:
 *
 *     unsafeSql("SELECT id FROM t WHERE u = ?")     ->   sql`SELECT id FROM t WHERE u = ?`
 *
 * Those are different bytes on disk and the SAME bytes at the database. A source-slice
 * comparison would report every single move as a difference and therefore prove
 * nothing; a cooked comparison reports only the differences that reach SQLite.
 *
 * Interpolations are rendered to a FIXED MARKER rather than evaluated, so a statement
 * assembled from a fragment is compared on its skeleton. That is a real limit and it
 * is stated rather than implied: this control proves the surrounding text is
 * unchanged and the interpolation count and positions are unchanged. It does NOT
 * prove the fragment itself is unchanged. A fragment that moves must be controlled
 * on its own text, by its own row here.
 *
 * ## What it collects
 *
 *   - `unsafeSql(<literal|template>)`   the counted escape, anywhere in the tree
 *   - the `sql` tag                     anywhere in the tree
 *
 * Both, everywhere, because the whole point is that a statement leaves the first form
 * in one file and appears in the second form in another. Restricting either side by
 * directory would make a moved statement look deleted.
 *
 * ## This is a ONE-SHOT MOVE CONTROL. It is not wired into CI.
 *
 * Despite living under `scripts/ci/`, nothing runs this automatically: it is in neither
 * `.github/workflows/` nor `package.json`. It is run by hand on both sides of a move
 * and its result reported in the PR. That is correct for what it does — it compares two
 * TREES, so it has no meaning on a single checkout — but the directory implies
 * otherwise, so it is said here rather than left to be assumed.
 *
 * The standing gates for this epic are `sqlText.escapeSet.test.ts` (the escape ratchet),
 * `sqlText.conduitSeam.test.ts` (the brand-launder guard) and
 * `scripts/ci/check-sql-boundary.mjs` (the boundary gate). Those do run on every PR.
 *
 * ## Usage
 *
 *     node scripts/ci/sql-move-identity.mjs --out before.json
 *     ... make the move ...
 *     node scripts/ci/sql-move-identity.mjs --out after.json
 *     node scripts/ci/sql-move-identity.mjs --compare before.json after.json
 *
 * `--compare` exits 1 if any statement present before is absent after. It is a SUBSET
 * assertion, not an equality: the after side legitimately contains statements the
 * before side does not (a fragment factored out during the move), and it legitimately
 * loses nothing. A statement that changed by one whitespace byte reads as
 * "before-only" and fails, which is the property under test.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import ts from "typescript";

const SKIP = new Set(["node_modules", "dist", "dist-electron", "build", ".git", "coverage"]);
const ROOTS = ["electron", "src", "scripts"];
/** The ratchet names everything it searches for in prose; it is not a producer. */
const SELF_EXCLUDE = new Set([
  "electron/services/db/core/__tests__/sqlText.escapeSet.test.ts",
  "scripts/ci/sql-move-identity.mjs",
]);
const FIXTURE_DIR = "electron/types/__typefixtures__/";

/** A marker no SQL statement contains, so a skeleton can never collide with real text. */
const SUBST = " <<SUBST>> ";

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (/\.tsx?$/.test(e.name)) out.push(path.join(dir, e.name));
  }
}

function sourceFiles(root) {
  const found = [];
  for (const r of ROOTS) {
    const abs = path.join(root, r);
    if (fs.existsSync(abs)) walk(abs, found);
  }
  return found
    .map((f) => path.relative(root, f).split(path.sep).join("/"))
    .filter((f) => !SELF_EXCLUDE.has(f) && !f.startsWith(FIXTURE_DIR))
    .sort();
}

/**
 * The COOKED text of a template or string literal, interpolations replaced by a
 * fixed marker. `.text` is the parsed value, so an escape sequence in a quoted
 * string and the real character in a template both arrive the same — which is
 * correct, because that is what SQLite receives.
 */
function cooked(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) s += SUBST + span.literal.text;
    return s;
  }
  if (ts.isParenthesizedExpression(node)) return cooked(node.expression);
  // `"SELECT ... (" + placeholders + ")"` — the template's older spelling. Same
  // skeleton, so it is rendered the same way: a non-literal operand becomes the
  // marker. Without this branch the one concatenated statement in the tree is
  // dropped, and a control that drops a statement reports nothing about it.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = cooked(node.left);
    const r = cooked(node.right);
    return (l === null ? SUBST : l) + (r === null ? SUBST : r);
  }
  return null; // an identifier or a call: not authored text at THIS node
}

const isScope = (n) =>
  ts.isSourceFile(n) ||
  ts.isBlock(n) ||
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isForStatement(n) ||
  ts.isCaseClause(n) ||
  ts.isModuleBlock(n);

/**
 * The nearest declaration of `name` visible from `from`, searching enclosing scopes
 * outward.
 *
 * ## Why this exists, and why it is scope-aware rather than name-keyed
 *
 * 33 of the tree's `unsafeSql` call sites pass an IDENTIFIER — the statement is built
 * into a local `const` a few lines above and then handed over. Collecting only the
 * argument node would silently omit their text, and a control that omits a statement
 * reports "unchanged" about a statement it never read. That is the exact shape this
 * epic keeps being caught by, so the identifier is followed rather than skipped.
 *
 * It resolves by nearest enclosing SCOPE, not by "any declaration in this file with
 * that name". A 1,878-line service has six declarations of `sql`; a name-keyed lookup
 * returns all six and looks resolved while being ambiguous. Measured during this
 * item's own classification: the name-keyed version attributed a value-splicing
 * fragment to six statements that do not contain it.
 */
function resolveLocal(sf, from, name) {
  let scope = from.parent;
  while (scope) {
    if (isScope(scope)) {
      let found = null;
      const scan = (n) => {
        if (found) return;
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === name &&
          n.initializer &&
          n.getStart(sf) < from.getStart(sf)
        ) {
          found = n.initializer;
        }
        // Do not descend into a NESTED scope while scanning this scope's own
        // declarations: an inner block's `const sql` is not visible out here.
        if (n !== scope && isScope(n) && !ts.isSourceFile(n)) return;
        ts.forEachChild(n, scan);
      };
      ts.forEachChild(scope, scan);
      if (found) return found;
    }
    scope = scope.parent;
  }
  return null;
}

/**
 * The four conduit verbs. Counted separately from the text, because "the same text
 * still exists" and "the same number of statements still EXECUTE" are two different
 * properties and a text-only control cannot tell them apart. Moving a statement into
 * `db/` behind a constant leaves the caller's own `dbAll(CONST, params)` call exactly
 * where it was, so this census is expected to be UNCHANGED by a move. A drop means a
 * call site was lost.
 */
const CONDUIT_VERBS = new Set(["dbGet", "dbAll", "dbRun", "dbExec"]);

function collect(root) {
  const rows = [];
  const conduit = {};
  for (const rel of sourceFiles(root)) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2020, true);
    const visit = (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        CONDUIT_VERBS.has(n.expression.text)
      ) {
        conduit[n.expression.text] = (conduit[n.expression.text] ?? 0) + 1;
      }
      let form = null;
      let node = null;
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "unsafeSql"
      ) {
        form = "unsafeSql";
        node = n.arguments[0];
      } else if (
        ts.isTaggedTemplateExpression(n) &&
        ts.isIdentifier(n.tag) &&
        n.tag.text === "sql"
      ) {
        form = "sql-tag";
        node = n.template;
      }
      if (node && form === "unsafeSql" && ts.isIdentifier(node)) {
        // The statement is built into a local const and handed over. Follow it, and
        // RECORD that we did — an unfollowable one must be visible, not silent.
        const init = resolveLocal(sf, n, node.text);
        if (init) {
          node = init;
          form = "unsafeSql-via-const";
        } else {
          rows.push({
            file: rel,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            form: "unsafeSql-UNFOLLOWED",
            hash: "unfollowed:" + node.text,
            preview: `argument is the identifier ${node.text}, declared outside this file`,
          });
          node = null;
        }
      }
      if (node) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        const c = cooked(node);
        if (c !== null) {
          rows.push({
            file: rel,
            line,
            form,
            hash: crypto.createHash("sha256").update(c).digest("hex").slice(0, 16),
            preview: c.replace(/\s+/g, " ").trim().slice(0, 90),
          });
        } else {
          // NEVER drop one silently. A statement this extractor cannot read is a
          // statement it is not controlling, and the only honest way to say so is
          // a row that shows up in the totals.
          rows.push({
            file: rel,
            line,
            form: form + "-UNREADABLE",
            hash: `unreadable:${rel}:${line}`,
            preview: `${ts.SyntaxKind[node.kind]} — not literal text: ${node
              .getText(sf)
              .replace(/\s+/g, " ")
              .slice(0, 70)}`,
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return { rows, conduit };
}

const args = process.argv.slice(2);

if (args[0] === "--compare") {
  const beforeDoc = JSON.parse(fs.readFileSync(args[1], "utf8"));
  const afterDoc = JSON.parse(fs.readFileSync(args[2], "utf8"));
  const before = beforeDoc.rows;
  const after = afterDoc.rows;

  const beforeCount = {};
  for (const r of before) beforeCount[r.hash] = (beforeCount[r.hash] ?? 0) + 1;
  const afterCount = {};
  for (const r of after) afterCount[r.hash] = (afterCount[r.hash] ?? 0) + 1;

  const where = (rows, h) =>
    rows.filter((r) => r.hash === h).map((r) => `${r.file}:${r.line}`).join(", ");

  // Synthetic rows are NOT statement text. `unfollowed:` / `unreadable:` are the
  // markers this extractor emits for an escape whose argument it cannot read — an
  // identifier imported from another module, or an expression that is not literal
  // text. They exist so such an escape is visible rather than silently dropped.
  //
  // One of them DISAPPEARING is the intended outcome of resolving that escape, not a
  // lost statement. BACKLOG-3044 PR 3 hit this: branding an already-in-layer constant
  // removed `unfollowed:CONTACT_SOURCE_RECORDS_SQL`, and the comparator reported a
  // byte-identity FAILURE for a statement whose text never moved and never changed.
  //
  // They are reported in their own section instead of being dropped from the corpus.
  // A spurious FAIL is not a harmless conservatism: a control that cries wolf is one
  // people learn to wave through, which is how a real difference gets waved through
  // with it.
  const synthetic = (h) => h.startsWith("unfollowed:") || h.startsWith("unreadable:");

  const syntheticGone = Object.keys(beforeCount).filter(
    (h) => synthetic(h) && !(h in afterCount),
  );
  const syntheticNew = Object.keys(afterCount).filter(
    (h) => synthetic(h) && !(h in beforeCount),
  );

  // THE ASSERTION — every distinct text authored before is still authored after.
  // A statement that changed by one whitespace byte hashes differently and lands
  // here. This is the byte-identity property, and it is what exits 1.
  const gone = Object.keys(beforeCount).filter((h) => !synthetic(h) && !(h in afterCount));

  // REPORTED, NOT ASSERTED — a text authored N times before and fewer times after.
  //
  // This is deliberately not a failure, and the reasoning matters. Two call sites
  // spelling out the SAME statement are two authored texts; consolidating them into
  // one exported constant that both call sites use is the drift removal this epic
  // exists to perform, and it necessarily reduces the count from 2 to 1. Failing on
  // it would make the control forbid the work it is controlling.
  //
  // What it must NOT hide is a call site being DELETED. That is a different property
  // — one about execution, not about text — so it is held by a different measurement:
  // the conduit call-site census below, plus the behavioural suites. Naming the limit
  // here rather than implying the multiset check covers it.
  const reduced = Object.keys(beforeCount)
    .filter((h) => !synthetic(h) && h in afterCount && afterCount[h] < beforeCount[h])
    .map((h) => ({ hash: h, before: beforeCount[h], after: afterCount[h],
      preview: before.find((r) => r.hash === h).preview, at: where(before, h) }));

  console.log(`before: ${before.length} authored statements, ${Object.keys(beforeCount).length} distinct texts`);
  console.log(`after:  ${after.length} authored statements, ${Object.keys(afterCount).length} distinct texts`);

  if (reduced.length) {
    console.log(`\nCONSOLIDATED — ${reduced.length} text(s) authored fewer times (reported, not a failure):`);
    for (const m of reduced) {
      console.log(`  ${m.hash}  ${m.before} -> ${m.after}   was at ${m.at}`);
      console.log(`      ${m.preview}`);
    }
  }

  if (syntheticGone.length || syntheticNew.length) {
    console.log("\nUNREADABLE-ESCAPE MARKERS changed (reported, not a failure):");
    for (const h of syntheticGone) {
      console.log(`  RESOLVED  ${h}`);
      console.log(`      was at ${where(before, h)}`);
      console.log("      an escape this extractor could not read is gone — check the PR says why");
    }
    for (const h of syntheticNew) {
      console.log(`  NEW       ${h}`);
      console.log(`      now at ${where(after, h)}`);
      console.log("      a NEW unreadable escape appeared; that is a surface this tool cannot control");
    }
  }

  const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
  console.log(`\nconduit call sites: ${sum(beforeDoc.conduit)} -> ${sum(afterDoc.conduit)}   ${JSON.stringify(beforeDoc.conduit)} -> ${JSON.stringify(afterDoc.conduit)}`);
  if (sum(beforeDoc.conduit) !== sum(afterDoc.conduit)) {
    console.log("  ^ CHANGED. A move leaves the caller's own call where it was, so this number should not move.");
  }

  if (gone.length) {
    console.log(`\nFAIL — ${gone.length} text(s) did not survive byte-identically:`);
    for (const h of gone) {
      console.log(`  ${h}  authored ${beforeCount[h]}x before, 0x after`);
      console.log(`      at ${where(before, h)}`);
      console.log(`      ${before.find((r) => r.hash === h).preview}`);
    }
    process.exit(1);
  }
  console.log("\nOK — every statement text authored before is still authored after, byte for byte.");
  process.exit(0);
}

const root = process.env.SQL_IDENTITY_ROOT || process.cwd();
const { rows, conduit } = collect(root);
const distinct = new Set(rows.map((r) => r.hash));
const byForm = {};
for (const r of rows) byForm[r.form] = (byForm[r.form] ?? 0) + 1;
console.log(`collected ${rows.length} authored statements (${distinct.size} distinct texts) from ${root}`);
console.log(`  by form: ${JSON.stringify(byForm)}`);
console.log(`  conduit call sites: ${JSON.stringify(conduit)} (total ${Object.values(conduit).reduce((a, b) => a + b, 0)})`);
const outIdx = args.indexOf("--out");
if (outIdx !== -1) {
  fs.writeFileSync(args[outIdx + 1], JSON.stringify({ root, rows, conduit }, null, 2));
  console.log(`  wrote ${args[outIdx + 1]}`);
}
