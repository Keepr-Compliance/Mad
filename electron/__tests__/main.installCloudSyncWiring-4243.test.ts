/**
 * BACKLOG-4243: main.ts installs Keepr Cloud during startup.
 *
 * `installCloudSync()` (electron/handlers/cloudSyncHandlers.ts) is the root of
 * the Keepr Cloud channels and engine. Its own behaviour is covered by
 * cloudSyncHandlers.install-4243.test.ts; this suite pins the one call site in
 * main.ts BY SOURCE SHAPE, parsed with the TypeScript compiler the way
 * main.startupFailureGuards-2962.test.ts pins its guards. Comments are not
 * nodes, so a commented-out call counts as no call.
 *
 * Pinned:
 *   - the import is a value import of installCloudSync
 *   - main.ts calls installCloudSync() exactly once
 *   - that call is a statement directly inside a try block that is itself a
 *     statement of the app.whenReady().then(...) handler body
 *   - the try has a catch, and the catch does not throw again
 */

import fs from "fs";
import path from "path";
import ts from "typescript";

const MAIN_TS = path.resolve(__dirname, "../main.ts");
const source = ts.createSourceFile(MAIN_TS, fs.readFileSync(MAIN_TS, "utf8"), ts.ScriptTarget.Latest, true);

function text(node: ts.Node): string {
  return node.getText(source);
}

function collect<T extends ts.Node>(predicate: (node: ts.Node) => node is T, root: ts.Node = source): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
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

/** Every `installCloudSync(...)` call expression in main.ts. */
function installCalls(): ts.CallExpression[] {
  return collect(ts.isCallExpression).filter(
    (call) => ts.isIdentifier(call.expression) && call.expression.text === "installCloudSync",
  );
}

describe("main.ts installs Keepr Cloud during startup", () => {
  it("imports installCloudSync as a value from ./handlers/cloudSyncHandlers", () => {
    const imports = source.statements.filter(
      (s): s is ts.ImportDeclaration =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === "./handlers/cloudSyncHandlers",
    );
    expect(imports).toHaveLength(1);
    const clause = imports[0].importClause;
    expect(clause?.isTypeOnly).toBeFalsy();
    expect(clause?.namedBindings && ts.isNamedImports(clause.namedBindings)).toBe(true);
    const element = (clause?.namedBindings as ts.NamedImports).elements.find((e) => e.name.text === "installCloudSync");
    expect(element).toBeDefined();
    expect(element?.isTypeOnly).toBeFalsy();
  });

  it("calls installCloudSync() exactly once", () => {
    const calls = installCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toHaveLength(0);
  });

  it("the call is a statement of a try block in the app.whenReady handler body", () => {
    const [call] = installCalls();
    expect(call).toBeDefined();
    const statement = call.parent;
    expect(ts.isExpressionStatement(statement)).toBe(true);
    const tryBlock = statement.parent;
    expect(ts.isBlock(tryBlock)).toBe(true);
    const tryStatement = tryBlock.parent;
    expect(ts.isTryStatement(tryStatement) && tryStatement.tryBlock === tryBlock).toBe(true);

    const handler = whenReadyHandler();
    expect(ts.isBlock(handler.body)).toBe(true);
    expect((handler.body as ts.Block).statements).toContain(tryStatement);
  });

  it("the try around the call has a catch that does not throw again", () => {
    const [call] = installCalls();
    expect(call).toBeDefined();
    const tryStatement = call.parent.parent.parent;
    expect(ts.isTryStatement(tryStatement)).toBe(true);
    const clause = (tryStatement as ts.TryStatement).catchClause;
    expect(clause).toBeDefined();
    expect(collect(ts.isThrowStatement, clause as ts.CatchClause)).toHaveLength(0);
    // The guarded block holds the install call and nothing that could throw first.
    expect((tryStatement as ts.TryStatement).tryBlock.statements.map(text)).toEqual(["installCloudSync();"]);
  });
});
