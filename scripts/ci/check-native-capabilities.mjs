#!/usr/bin/env node
/**
 * NATIVE CAPABILITY BOUNDARY GATE — BACKLOG-2962
 * ============================================================================
 * Two rules, both enforced by AST, never by line matching.
 *
 *   R1  `safeStorage` may be value-imported ONLY inside
 *       electron/capabilities/electron/** (plus its own test).
 *
 *   R2  A module on the PORTABLE list may not value-import "electron" at all.
 *       This is a ratchet: BACKLOG-2962 put two modules on it; later items in
 *       epic 9 add to it as they decouple modules. A module that comes off the
 *       list has regressed.
 *
 * WHY AST AND NOT grep
 * --------------------
 * This item's own scope was mis-measured three times by line matching. The
 * filed count was 86; a review corrected it to 17 sites in 10 files; a second
 * pass said 15 in 6. The truth is 14 call expressions in 5 files. The extra
 * "file" was `electron/services/supportAccess/index.ts`, which mentions
 * `safeStorage.encryptString()` **inside a JSDoc comment** and never calls it.
 * A gate built on the same instrument would inherit the same defect, so this
 * one resolves import bindings with the TypeScript compiler: a comment, a
 * string literal, a `import type`, or an identically-named import from some
 * other module cannot produce a finding. Static, `require()` and dynamic
 * `await import()` forms are all resolved, because a lazy reach couples a
 * module exactly as firmly as an eager one — and this tree already uses lazy
 * `require()` (`hybridExtractorService.ts`). `scripts/__tests__/
 * check-native-capabilities.verify.js` proves each of those, by planting.
 *
 * WHY THE WORKING TREE AND NOT `git ls-files`
 * -------------------------------------------
 * BACKLOG-3049: the SQL gate enumerated tracked files only, so a brand-new
 * module was invisible to it until staged — and a new module is exactly where a
 * fresh violation appears. This enumerates tracked AND untracked-but-not-ignored
 * files.
 *
 * Usage:  node scripts/ci/check-native-capabilities.mjs [--root <dir>] [--json]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..", "..");

const argv = process.argv.slice(2);
const rootArg = argv.indexOf("--root");
const ROOT = rootArg === -1 ? DEFAULT_ROOT : path.resolve(argv[rootArg + 1]);
const AS_JSON = argv.includes("--json");

/** The capability's platform implementation directory — the only place safeStorage may live. */
const SAFE_STORAGE_HOME = "electron/capabilities/electron/";

/**
 * Modules asserted to be free of a direct "electron" value import.
 *
 * BACKLOG-2962 decoupled these two from Electron entirely: both previously
 * opened with `import { safeStorage } from "electron"` and now take a
 * SecretStore. `electron/capabilities/__tests__/coreLoadsWithoutElectron.test.ts`
 * asserts the same property at RUNTIME by loading them with "electron" made to
 * throw; this asserts it statically, so a regression is caught even by a change
 * that never runs that suite.
 */
const PORTABLE = new Set([
  "electron/services/keychainGate.ts",
  "electron/services/tokenEncryptionService.ts",
]);

function enumerateFiles() {
  // Tracked + untracked-but-not-ignored, NUL-separated so paths with spaces survive.
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const seen = new Set();
  for (const rel of out.split("\0")) {
    if (!rel) continue;
    if (!/\.(ts|tsx|mts|cts)$/.test(rel)) continue;
    if (rel.includes("node_modules/")) continue;
    // `--others` lists a deleted-but-tracked path too; skip anything not on disk.
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    seen.add(rel);
  }
  return [...seen].sort();
}

/**
 * Resolve every VALUE binding a file takes from "electron".
 *
 * Returns { named: Map<localName, exportName>, namespaces: Set<localName> }.
 * Type-only imports are excluded: they are erased and cannot call anything.
 */
/** Stands in for a dynamic `import("electron")` that binds no name. */
const DYNAMIC_IMPORT_MARK = 'await import("electron")';

function electronBindings(sourceFile) {
  const named = new Map();
  const namespaces = new Set();

  const visit = (node) => {
    // import ... from "electron"
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "electron"
    ) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) namespaces.add(clause.name.text); // default import
        const nb = clause.namedBindings;
        if (nb) {
          if (ts.isNamespaceImport(nb)) {
            namespaces.add(nb.name.text);
          } else {
            for (const el of nb.elements) {
              if (el.isTypeOnly) continue;
              named.set(el.name.text, (el.propertyName ?? el.name).text);
            }
          }
        }
      }
    }

    // import electron = require("electron")
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      node.moduleReference.expression.text === "electron"
    ) {
      namespaces.add(node.name.text);
    }

    // const X = require("electron")            /  const { safeStorage: y } = require("electron")
    // const X = await import("electron")        /  const { safeStorage: y } = await import("electron")
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (isRequireElectron(node.initializer) || isDynamicImportElectron(node.initializer))
    ) {
      if (ts.isIdentifier(node.name)) {
        namespaces.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const exported = el.propertyName && ts.isIdentifier(el.propertyName)
            ? el.propertyName.text
            : el.name.text;
          named.set(el.name.text, exported);
        }
      }
    }

    // A dynamic import reached for its side effect or used inline, with no
    // binding to name. R2 still has to see it: `(await import("electron")).app`
    // couples the module just as firmly as a static import does.
    if (isDynamicImportElectron(node) && !ts.isVariableDeclaration(node.parent)) {
      namespaces.add(DYNAMIC_IMPORT_MARK);
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { named, namespaces };
}

/**
 * `x` with any number of `await`s, parentheses, `as`-casts and `!` peeled off.
 *
 * Parentheses are not cosmetic here: `(await import("electron")).safeStorage`
 * parses as a PropertyAccessExpression on a ParenthesizedExpression, and a
 * matcher that only peeled `await` missed that exact line. Harness control C19
 * is that line, and it went red before this function grew.
 */
function unwrapExpr(expr) {
  let e = expr;
  for (;;) {
    if (!e) return e;
    if (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else return e;
  }
}

/**
 * `import("electron")` — the dynamic form.
 *
 * Live shape in this tree, not a hypothetical: `hybridExtractorService.ts`
 * already reaches `tokenEncryptionService` through a lazy `require()`, and the
 * ESM equivalent of that habit is `await import(...)`. A gate that only reads
 * static imports would wave it through.
 */
function isDynamicImportElectron(expr) {
  const e = unwrapExpr(expr);
  return (
    e &&
    ts.isCallExpression(e) &&
    e.expression.kind === ts.SyntaxKind.ImportKeyword &&
    e.arguments.length >= 1 &&
    ts.isStringLiteralLike(e.arguments[0]) &&
    e.arguments[0].text === "electron"
  );
}

function isRequireElectron(expr) {
  const e = unwrapExpr(expr);
  return (
    !!e &&
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "require" &&
    e.arguments.length === 1 &&
    ts.isStringLiteralLike(e.arguments[0]) &&
    e.arguments[0].text === "electron"
  );
}

/** Every place this file reaches `safeStorage` as a value, with a 1-based line. */
function safeStorageSites(sourceFile, bindings) {
  const sites = [];
  const at = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  // A named binding of the `safeStorage` export is itself the reach.
  for (const [local, exported] of bindings.named) {
    if (exported === "safeStorage") sites.push({ line: null, form: `import { safeStorage${local === exported ? "" : ` as ${local}`} }` });
  }

  const visit = (node) => {
    // <electronNamespace>.safeStorage
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "safeStorage" &&
      ts.isIdentifier(node.expression) &&
      bindings.namespaces.has(node.expression.text)
    ) {
      sites.push({ line: at(node), form: `${node.expression.text}.safeStorage` });
    }
    // require("electron").safeStorage  /  (await import("electron")).safeStorage
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "safeStorage" &&
      (isRequireElectron(node.expression) || isDynamicImportElectron(node.expression))
    ) {
      const form = isRequireElectron(node.expression)
        ? 'require("electron").safeStorage'
        : '(await import("electron")).safeStorage';
      sites.push({ line: at(node), form });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

const violations = [];
const files = enumerateFiles();
let safeStorageFiles = 0;
let portableChecked = 0;

for (const rel of files) {
  const abs = path.join(ROOT, rel);
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  // Cheap pre-filter. Sound for FINDINGS — both rules require a module specifier
  // that is literally "electron", so a file without that substring cannot violate
  // either. It is NOT sound for the portable-module CENSUS: `keychainGate.ts`
  // contains only the capitalised word "Electron" in prose, so the filter skipped
  // it and the gate reported "1 of 2 portable modules checked" while claiming
  // success. A counter that silently undercounts is how a gate comes to be
  // believed without having run, so portable modules bypass the filter and are
  // always parsed.
  if (!PORTABLE.has(rel) && !text.includes("electron")) continue;

  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const bindings = electronBindings(sf);

  // R1 — safeStorage outside its home
  const sites = safeStorageSites(sf, bindings);
  if (sites.length > 0) {
    safeStorageFiles++;
    const allowed = rel.startsWith(SAFE_STORAGE_HOME);
    if (!allowed) {
      for (const s of sites) {
        violations.push({
          rule: "R1",
          file: rel,
          line: s.line,
          detail: `${s.form} — safeStorage may only be value-imported inside ${SAFE_STORAGE_HOME}`,
        });
      }
    }
  }

  // R2 — a declared-portable module must not value-import "electron" at all
  if (PORTABLE.has(rel)) {
    portableChecked++;
    const reached = [...bindings.named.values(), ...bindings.namespaces];
    if (reached.length > 0) {
      violations.push({
        rule: "R2",
        file: rel,
        line: null,
        detail:
          `value-imports { ${reached.join(", ")} } from "electron" — this module is ` +
          "declared portable (BACKLOG-2962). Take the capability as a constructor " +
          "parameter instead of importing the platform.",
      });
    }
  }
}

const missingPortable = [...PORTABLE].filter((p) => !files.includes(p));
for (const p of missingPortable) {
  violations.push({
    rule: "R2",
    file: p,
    line: null,
    detail: "declared portable but not found in the working tree — the list is stale",
  });
}

if (AS_JSON) {
  console.log(JSON.stringify({ files: files.length, safeStorageFiles, portableChecked, violations }, null, 2));
} else {
  console.log("Native capability gate — safeStorage lives in one place; portable modules stay portable");
  console.log(`  files enumerated        ${files.length}`);
  console.log(`  files reaching safeStorage  ${safeStorageFiles}  (allowed home: ${SAFE_STORAGE_HOME})`);
  console.log(`  portable modules checked    ${portableChecked} of ${PORTABLE.size}`);
  console.log(`  VIOLATIONS              ${violations.length}`);
  if (violations.length) {
    console.log("");
    for (const v of violations) {
      console.log(`  ${v.rule}  ${v.file}${v.line ? `:${v.line}` : ""}`);
      console.log(`      ${v.detail}`);
    }
    console.log("");
    console.log("FAIL — see electron/capabilities/secretStore.ts for the interface to depend on.");
  } else {
    console.log("");
    console.log("OK — no module reaches a native capability past its interface.");
  }
}

process.exit(violations.length ? 1 : 0);
