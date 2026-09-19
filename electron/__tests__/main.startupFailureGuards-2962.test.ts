/**
 * THE THREE `main.ts` PATHS THAT STAND DOWN WHEN THE COMPOSITION ROOT FAILED
 * (BACKLOG-2962).
 *
 * The fatal `catch` in `electron/bootstrap/installNativeCapabilities.ts` waits
 * for Sentry before it shows the box and exits, and an `import` cannot be
 * caught — so `main.ts` keeps evaluating while that flush is pending. Three of
 * its paths would act on a half-built shell in that gap, and each now reads
 * `getStartupFailure()` first:
 *
 *   1. the lost single-instance lock's `app.quit()` — exit 0 before the exit 1
 *   2. the `whenReady` body — `runStartupHealthChecks()` demands the missing
 *      capability, `createWindow()` opens a window
 *   3. `activate` — `createWindow()` again, on first launch on macOS
 *
 * WHAT THIS SUITE IS, AND IS NOT. `main.ts` is 1,900 lines of module-level
 * side effects; the five suites that reach it through `systemHandlers.ts` all
 * `jest.doMock("../main")` rather than load it. This suite therefore pins the
 * three sites BY SOURCE SHAPE, the way `compositionRootGuard.test.ts` pins the
 * entry imports — the guard must be the FIRST statement of the handler, and
 * the lock condition must carry it — and it does not execute them. That the
 * guards behave at runtime is the founder's launch check, not this file.
 *
 * The last case is the non-vacuity check: every `createWindow()` call in
 * `main.ts` must sit inside one of the two guarded handlers, so a third call
 * site added later reds here rather than opening a window on the fatal path.
 */

import fs from "fs";
import path from "path";
import ts from "typescript";

const MAIN_TS = path.resolve(__dirname, "../main.ts");
const source = ts.createSourceFile(MAIN_TS, fs.readFileSync(MAIN_TS, "utf8"), ts.ScriptTarget.Latest, true);

const GUARD = "if (getStartupFailure()) return;";

function text(node: ts.Node): string {
  return node.getText(source);
}

function collect<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The single arrow function passed to `app.whenReady().then(...)`. */
function whenReadyHandler(): ts.ArrowFunction {
  const calls = collect(ts.isCallExpression).filter(
    (call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "then" &&
      text(call.expression.expression) === "app.whenReady()",
  );
  expect(calls).toHaveLength(1);
  const handler = calls[0].arguments[0];
  expect(ts.isArrowFunction(handler)).toBe(true);
  return handler as ts.ArrowFunction;
}

/** The single arrow function passed to `app.on("activate", ...)`. */
function activateHandler(): ts.ArrowFunction {
  const calls = collect(ts.isCallExpression).filter(
    (call) =>
      text(call.expression) === "app.on" &&
      call.arguments.length === 2 &&
      ts.isStringLiteral(call.arguments[0]) &&
      call.arguments[0].text === "activate",
  );
  expect(calls).toHaveLength(1);
  const handler = calls[0].arguments[1];
  expect(ts.isArrowFunction(handler)).toBe(true);
  return handler as ts.ArrowFunction;
}

function firstStatement(fn: ts.ArrowFunction): string {
  expect(ts.isBlock(fn.body)).toBe(true);
  const block = fn.body as ts.Block;
  expect(block.statements.length).toBeGreaterThan(0);
  return text(block.statements[0]);
}

describe("main.ts stands down on a recorded startup failure (BACKLOG-2962)", () => {
  it("imports getStartupFailure as a value from ./bootstrap/startupFailure", () => {
    const imports = source.statements.filter(
      (s): s is ts.ImportDeclaration =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === "./bootstrap/startupFailure",
    );
    expect(imports).toHaveLength(1);
    const clause = imports[0].importClause;
    expect(clause?.isTypeOnly).toBeFalsy();
    expect(clause?.namedBindings && ts.isNamedImports(clause.namedBindings)).toBe(true);
    const names = (clause?.namedBindings as ts.NamedImports).elements.map((e) => e.name.text);
    expect(names).toContain("getStartupFailure");
  });

  it("the lost single-instance lock does not app.quit() — that would be exit 0 before the exit 1", () => {
    const lockChecks = source.statements.filter(
      (s): s is ts.IfStatement => ts.isIfStatement(s) && text(s.expression).includes("!gotTheLock"),
    );
    expect(lockChecks).toHaveLength(1);
    const [check] = lockChecks;
    expect(text(check.expression)).toBe("!gotTheLock && !getStartupFailure()");
    // Still the quit, still in the same branch: the guard changed the
    // condition, not what the branch does.
    expect(text(check.thenStatement)).toContain("app.quit();");
  });

  it("the whenReady body's FIRST statement is the stand-down — nothing runs before it", () => {
    expect(firstStatement(whenReadyHandler())).toBe(GUARD);
  });

  it("the activate handler's FIRST statement is the stand-down", () => {
    expect(firstStatement(activateHandler())).toBe(GUARD);
  });

  it("every createWindow() call in main.ts sits inside one of the two guarded handlers", () => {
    const guarded = new Set<ts.Node>([whenReadyHandler(), activateHandler()]);
    const calls = collect(ts.isCallExpression).filter((call) => text(call) === "createWindow()");
    // Non-vacuity: at least the two call sites that exist today.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      let node: ts.Node | undefined = call;
      let insideGuarded = false;
      while (node) {
        if (guarded.has(node)) {
          insideGuarded = true;
          break;
        }
        node = node.parent;
      }
      expect({ call: text(call), line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1, insideGuarded }).toEqual(
        expect.objectContaining({ insideGuarded: true }),
      );
    }
  });
});
