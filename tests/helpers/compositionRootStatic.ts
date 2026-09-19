/**
 * STATIC composition-root guard — the AST half of BACKLOG-2962's remainder.
 *
 * WHAT IT CHECKS
 * --------------
 *   E1  The shell's entry module (`electron/main.ts`) contains a TOP-LEVEL
 *       import whose specifier RESOLVES to the composition root.
 *   E2  For each required ENTRY import, the entry module contains a top-level
 *       import that RESOLVES to it — and, where that import's contract says so,
 *       it is the entry's FIRST statement.
 *   C1  For each required call, the composition root contains a call
 *       expression whose callee resolves, THROUGH AN IMPORT BINDING, to the
 *       named export of the named module.
 *
 * WHY IT IS AN AST WALK AND NOT A LINE MATCH
 * ------------------------------------------
 * This repo has had seven line matchers produce wrong answers, three of them on
 * this very item (86 -> 17/10 -> 15/6; the truth was 14 call expressions in 5
 * files, every error a mention counted as a call). So:
 *   - `installSecretStore` written in a comment or a string literal does not
 *     satisfy C1;
 *   - a LOCALLY DECLARED `function installSecretStore()` called locally does
 *     not satisfy C1 — the callee must resolve to the provider module;
 *   - `./bootstrap/../bootstrap/installNativeCapabilities` DOES satisfy E1,
 *     because specifiers are resolved to a repo-relative path rather than
 *     compared as strings;
 *   - `import * as p` + `p.installSecretStore(...)` and
 *     `import { installSecretStore as x }` + `x(...)` both satisfy C1.
 * Every one of those is a planted control in
 * `electron/capabilities/__tests__/compositionRootGuard.test.ts`.
 *
 * WHY E1 ASSERTS NO ORDERING AND E2 SOMETIMES DOES
 * ------------------------------------------------
 * A top-level import executes during the entry module's evaluation, which
 * completes before Electron's `ready` event fires — so the composition root
 * runs before `createWindow()` whatever its statement index. Statement ORDER is
 * therefore not what makes that true, and asserting an order would forbid
 * rearrangements that are perfectly valid.
 *
 * E1 walks `sourceFile.statements` rather than the whole tree, but that buys
 * less than it looks like: TypeScript's grammar already forbids an
 * `ImportDeclaration` inside a function or a block, so the restriction excludes
 * nothing the parser would have accepted elsewhere. What E1 genuinely excludes
 * is every CALL form — see the "does not cover" list below.
 *
 * E2 is the same presence check plus an OPTIONAL position rule, and it exists
 * because one bootstrap import does have an ordering contract: BACKLOG-2709's
 * `installAppDataPaths` must repoint userData before anything reads it, and
 * `electron/main.ts:1-5` says so in prose. `mustBeFirstStatement` is what makes
 * that prose enforceable. It is read from the registry per entry, never
 * assumed: an entry with `mustBeFirstStatement: false` is checked for presence
 * only, on exactly E1's reasoning.
 *
 * WHAT IT FALSELY REJECTS — correct code this guard reds on
 * ---------------------------------------------------------
 * Measured by SR's review of PR #2515, which ran five plausible refactors
 * through `checkCompositionRoot` against the real registry. Three are rejected
 * although they are correct code:
 *
 *   - a BARREL RE-EXPORT — `import { installSecretStore,
 *     assertNativeCapabilitiesInstalled } from "../capabilities"` — rejects
 *     both required calls;
 *   - the ASSERT moved into a sibling module (e.g. `./verifyCapabilities`) —
 *     rejects `the runtime self-check`;
 *   - the INSTALL moved into a sibling module (e.g. `./installStores`) —
 *     rejects `secretStore`.
 *
 * E2 adds two of its own, both from the position rule and both narrow:
 *
 *   - a TYPE-ONLY import placed above a `mustBeFirstStatement` entry is
 *     rejected, although TypeScript erases it and it can execute nothing.
 *     "First" is `statements[0]`, literally. Loosening it would mean teaching
 *     this file which statement kinds survive emit — a second, drifting copy of
 *     the compiler's rule — to protect a case nobody has hit above a comment
 *     block that reads "This import MUST stay first";
 *   - a re-export chain — `import "./bootstrap"` where that barrel imports
 *     `installAppDataPaths` — is rejected, on the same one-hop resolution limit
 *     C1 has.
 *
 * The common cause of the three C1 rejections is CROSS-MODULE INDIRECTION: C1 resolves a callee one hop,
 * to the module the composition root imports it from, and does not follow a
 * re-export or descend into another file. No barrel exists today
 * (`electron/capabilities/index.ts` is absent), so nothing is broken now — but
 * the first engineer to add one meets a red guard on correct code, and a guard
 * that reds on correct code is a guard people learn to delete. Naming the gap
 * is what prevents that.
 *
 * NOTE, because an earlier version of this header got it backwards: a
 * SAME-FILE wrapper — `function installAll() { installSecretStore(...) }` then
 * `installAll()` — is ACCEPTED. `callsRequired` walks the whole tree with
 * `forEachChild`, so a call nested inside a local function satisfies C1 just as
 * the already-planted `try {}` case does. "Wrapper functions" was listed here
 * as uncovered and is in fact covered.
 *
 * WHAT IT LETS THROUGH — no completeness claim beyond this list
 * -------------------------------------------------------------
 *   - An install call that EXISTS but never RUNS — inside a function nobody
 *     invokes, or a branch never taken. C1 is a reachability floor, not a
 *     control-flow proof. The RUNTIME layer is what catches this.
 *   - Calls reached through a dynamic `await import()`.
 *   - `import installX from "..."` (default import). Named, aliased-named,
 *     namespace and `require()`-destructured forms are recognised; the default
 *     form is not, because no module in this tree default-exports an installer.
 *   - Any CALL-shaped entry import. E1 recognises `import "..."` and
 *     `import x = require("...")` only. A top-level `require("./bootstrap/…")`
 *     statement — valid in this tree's CommonJS emit — or a dynamic
 *     `import("./bootstrap/…")` is reported as MISSING, not accepted. That is
 *     conservative in the safe direction (it over-reports), but it is a false
 *     positive waiting for anyone who rewrites `main.ts` in that style.
 *   - Install ORDER between CAPABILITIES, and every ordering between bootstrap
 *     modules except the one E2 asserts: that a `mustBeFirstStatement` entry is
 *     the entry module's first statement. Nothing here says the composition
 *     root runs after the app-data override — only that the override is first,
 *     which implies it.
 *   - Whether the installed implementation WORKS. That is
 *     `electron/capabilities/electron/__tests__/electronSecretStore.test.ts`.
 *   - Whether the capability is reachable at all in a packaged build. Nothing
 *     here runs a bundler.
 *   - A RUNTIME check on any E2 entry. E2 is static only. Whether
 *     `installAppDataPaths` actually ran is not asserted anywhere at launch —
 *     deliberately, with the two measurements behind that choice recorded on
 *     `REQUIRED_ENTRY_IMPORTS` in `electron/capabilities/nativeCapabilities.ts`.
 *     (Before that list existed, this line said `installAppDataPaths` was
 *     unguarded and out of scope. E2 is now the guard; the entry is kept in
 *     amended form so the change is legible rather than silently deleted.)
 *   - Any shell other than Electron. `entryFile` is a parameter, but only
 *     `electron/main.ts` is asserted today.
 *
 * @module tests/helpers/compositionRootStatic
 */

import * as path from "path";
import * as ts from "typescript";

/** A call the composition root must make, identified by module + export. */
export interface RequiredCall {
  /** Name used in failure messages — a capability name, or a description. */
  readonly name: string;
  /** Repo-relative, extensionless, POSIX path of the module exporting it. */
  readonly providerModule: string;
  /** The named export that must be called. */
  readonly installFunction: string;
}

/** One thing the guard found wrong. */
export interface Finding {
  readonly rule: "E1" | "E2" | "C1";
  /**
   * The capability/call name for C1, the entry import's name for E2; the entry
   * file for E1.
   */
  readonly subject: string;
  readonly detail: string;
}

/**
 * A side-effect import the shell ENTRY must make, beyond the composition root.
 *
 * Structurally identical to the registry's `RequiredEntryImport`; restated here
 * so this helper depends on no production module, exactly as `RequiredCall` is.
 */
export interface RequiredEntryImport {
  /** Name used in failure messages — a description, not an identifier. */
  readonly name: string;
  /** Repo-relative, extensionless, POSIX path of the module to import. */
  readonly module: string;
  /** True when presence is not enough and it must be `statements[0]`. */
  readonly mustBeFirstStatement: boolean;
  /** Why the entry needs it. Quoted into the failure message. */
  readonly why: string;
}

export interface CompositionRootInput {
  /** Repo-relative POSIX path of the shell entry, e.g. `electron/main.ts`. */
  readonly entryFile: string;
  readonly entrySource: string;
  /** Repo-relative, extensionless, POSIX path of the composition root. */
  readonly compositionRoot: string;
  readonly compositionRootSource: string;
  readonly requiredCalls: readonly RequiredCall[];
  /**
   * Side-effect imports the ENTRY must make, checked by E2.
   *
   * Optional and defaulting to none, so a caller that only wants E1 and C1 gets
   * byte-identical findings to the ones it got before E2 existed.
   */
  readonly requiredEntryImports?: readonly RequiredEntryImport[];
}

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Resolve a RELATIVE module specifier to a repo-relative, extensionless path.
 *
 * Returns `null` for bare and aliased specifiers (`"electron"`, `"@electron/x"`)
 * — nothing in this tree imports the composition root that way, and guessing at
 * `tsconfig` path mapping here would be a second resolver to keep correct.
 *
 * `path.posix` throughout: CI runs this on Windows, where `path.join` would
 * emit backslashes that never match a registry constant.
 */
export function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromPosix = fromFile.split(path.sep).join("/");
  // `path.posix.join` already collapses `..` and `.`, so no separate normalise
  // call is needed. There WAS one here; mutation-testing removed it and nothing
  // went red, which is how it was found to be redundant rather than
  // belt-and-braces. Removing `join` itself DOES red three cases, so the one
  // remaining normaliser is load-bearing.
  const joined = path.posix.join(path.posix.dirname(fromPosix), specifier);
  return joined.replace(SOURCE_EXT, "").replace(/\/index$/, "");
}

/** `require("x")` with `await`, parens, `as` and `!` peeled off. */
function requireTarget(expr: ts.Expression | undefined): string | null {
  let e: ts.Node | undefined = expr;
  for (;;) {
    if (!e) return null;
    if (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else break;
  }
  if (
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "require" &&
    e.arguments.length === 1 &&
    ts.isStringLiteralLike(e.arguments[0])
  ) {
    return e.arguments[0].text;
  }
  return null;
}

/**
 * The module a TOP-LEVEL statement imports, resolved — or `null` if it is not
 * an import statement at all.
 *
 * Recognises the same two forms E1 does, `import "..."` and
 * `import x = require("...")`, and deliberately duplicates that recognition
 * rather than sharing a helper with E1. E1 is the rule PR #2515 shipped and SR
 * measured; refactoring it to serve a second caller would put its behaviour
 * change beyond the reach of the twenty cases that currently pin it, and no
 * existing case exercises its `import x = require(...)` branch. Ten duplicated
 * lines are cheaper than an unmeasured change to a merged guard.
 */
function entryImportedModule(stmt: ts.Statement, entryFile: string): string | null {
  if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
    return resolveSpecifier(entryFile, stmt.moduleSpecifier.text);
  }
  if (
    ts.isImportEqualsDeclaration(stmt) &&
    ts.isExternalModuleReference(stmt.moduleReference) &&
    ts.isStringLiteral(stmt.moduleReference.expression)
  ) {
    return resolveSpecifier(entryFile, stmt.moduleReference.expression.text);
  }
  return null;
}

interface Bindings {
  /** local name -> { module, exportName } */
  readonly named: Map<string, { module: string; exportName: string }>;
  /** local name -> module (namespace import / whole-module require) */
  readonly namespaces: Map<string, string>;
}

/**
 * Every VALUE binding the file takes from a relative module, resolved to a
 * repo-relative module path. Type-only imports are excluded: they are erased
 * and cannot call anything.
 */
function collectBindings(sourceFile: ts.SourceFile, filePath: string): Bindings {
  const named = new Map<string, { module: string; exportName: string }>();
  const namespaces = new Map<string, string>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause &&
      !node.importClause.isTypeOnly
    ) {
      const mod = resolveSpecifier(filePath, node.moduleSpecifier.text);
      if (mod) {
        const nb = node.importClause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) {
          namespaces.set(nb.name.text, mod);
        } else if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly) continue;
            named.set(el.name.text, {
              module: mod,
              exportName: (el.propertyName ?? el.name).text,
            });
          }
        }
        // `import installX from "..."` (default) is deliberately NOT recorded —
        // see the module header's "does not cover" list.
      }
    }

    // import p = require("...")
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const mod = resolveSpecifier(filePath, node.moduleReference.expression.text);
      if (mod) namespaces.set(node.name.text, mod);
    }

    // const p = require("...")  /  const { installX: y } = require("...")
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const spec = requireTarget(node.initializer);
      const mod = spec === null ? null : resolveSpecifier(filePath, spec);
      if (mod) {
        if (ts.isIdentifier(node.name)) {
          namespaces.set(node.name.text, mod);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const exportName =
              el.propertyName && ts.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : el.name.text;
            named.set(el.name.text, { module: mod, exportName });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { named, namespaces };
}

/** Does `file` call `required.installFunction` as exported by its module? */
function callsRequired(
  sourceFile: ts.SourceFile,
  bindings: Bindings,
  required: RequiredCall,
): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      // installX(...) where installX came from the provider module
      if (ts.isIdentifier(callee)) {
        const binding = bindings.named.get(callee.text);
        if (
          binding &&
          binding.module === required.providerModule &&
          binding.exportName === required.installFunction
        ) {
          found = true;
          return;
        }
      }

      // p.installX(...) where p is a namespace of the provider module
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.name.text === required.installFunction &&
        bindings.namespaces.get(callee.expression.text) === required.providerModule
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Parse `source` as TypeScript with parent pointers set. */
function parse(filePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/**
 * Run E1 and C1. Returns every finding; an empty array means the guard passes.
 *
 * Deterministic order: E1 first, then E2 in `requiredEntryImports` order, then
 * C1 in `requiredCalls` order, so a failure message reads the same on every
 * machine. Each E2 entry contributes at most one finding: a missing import is
 * not also reported as mis-positioned.
 */
export function checkCompositionRoot(input: CompositionRootInput): Finding[] {
  const findings: Finding[] = [];

  // ---- E1: the entry module imports the composition root, at top level ----
  const entry = parse(input.entryFile, input.entrySource);
  const importsRoot = entry.statements.some((stmt) => {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      return resolveSpecifier(input.entryFile, stmt.moduleSpecifier.text) === input.compositionRoot;
    }
    if (
      ts.isImportEqualsDeclaration(stmt) &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      ts.isStringLiteral(stmt.moduleReference.expression)
    ) {
      return (
        resolveSpecifier(input.entryFile, stmt.moduleReference.expression.text) ===
        input.compositionRoot
      );
    }
    return false;
  });

  if (!importsRoot) {
    findings.push({
      rule: "E1",
      subject: input.entryFile,
      detail:
        `${input.entryFile} has no top-level import that resolves to ` +
        `${input.compositionRoot}. Nothing installs the shell's native capabilities, ` +
        "so the core reaches an uninstalled provider and the app launches without a window. " +
        "This is the exact mutation that went red nowhere before this guard existed.",
    });
  }

  // ---- E2: the entry imports each required bootstrap module, in position ----
  for (const required of input.requiredEntryImports ?? []) {
    const index = entry.statements.findIndex(
      (stmt) => entryImportedModule(stmt, input.entryFile) === required.module,
    );

    if (index === -1) {
      findings.push({
        rule: "E2",
        subject: required.name,
        detail:
          `${input.entryFile} has no top-level import that resolves to ` +
          `${required.module}. The entry needs it because ${required.why}. ` +
          "Deleting this import is invisible to tsc and to every other suite in " +
          "the repository — that is the defect this rule exists for.",
      });
      continue;
    }

    if (required.mustBeFirstStatement && index !== 0) {
      const preceding = entry.statements[0];
      const precedingText = preceding.getText(entry).split("\n")[0].trim();
      findings.push({
        rule: "E2",
        subject: required.name,
        detail:
          `${input.entryFile} imports ${required.module}, but as statement ` +
          `${index + 1} rather than the first. It must be first because ` +
          `${required.why}. Statement 1 is currently \`${precedingText}\`. ` +
          "Position IS execution position here: tsconfig.electron.json emits " +
          "CommonJS, which preserves statement order.",
      });
    }
  }

  // ---- C1: the composition root actually calls each required installer ----
  const rootFile = `${input.compositionRoot}.ts`;
  const root = parse(rootFile, input.compositionRootSource);
  const bindings = collectBindings(root, rootFile);

  for (const required of input.requiredCalls) {
    if (!callsRequired(root, bindings, required)) {
      findings.push({
        rule: "C1",
        subject: required.name,
        detail:
          `${input.compositionRoot} never calls ${required.installFunction}() as imported ` +
          `from ${required.providerModule}, so "${required.name}" is registered but never ` +
          "installed. A same-named local function or a mention in a comment does not count: " +
          "the callee must resolve through an import binding.",
      });
    }
  }

  return findings;
}
