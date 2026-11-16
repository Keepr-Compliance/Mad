/**
 * @jest-environment node
 */
/*
 * BACKLOG-4212 — wiring pin: main.ts registers the Learn suppress channels at
 * startup.
 *
 * `registerLearnSuppressHandlers()` (learn:list-suppressed, learn:set-override)
 * has one production caller: the `app.whenReady().then(...)` body in main.ts.
 * The behaviour suite (handlers/__tests__/learnSuppressHandlers-4212.test.ts)
 * calls the function directly, so deleting the main.ts call left every test
 * and tsc green while both channels went unregistered.
 *
 * main.ts is not loadable in jest (module-level side effects; see
 * main.startupFailureGuards-2962.test.ts), so this pins the call BY AST, the
 * way 2962 pins the startup guards. Parsing — not string search — means a
 * commented-out call does not count, and requiring the call to be a direct
 * statement of the whenReady body means a call moved into a nested function,
 * a branch or a callback does not count either.
 *
 * Controls (BACKLOG-4212 pm_comments): deleting the call, commenting it out,
 * and moving it into a function that is never called each red this suite.
 */

import fs from "fs";
import path from "path";
import ts from "typescript";

const MAIN_TS = path.resolve(__dirname, "../main.ts");
const source = ts.createSourceFile(MAIN_TS, fs.readFileSync(MAIN_TS, "utf8"), ts.ScriptTarget.Latest, true);

const FN = "registerLearnSuppressHandlers";
const MODULE = "./handlers/learnSuppressHandlers";

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

function callsTo(name: string): ts.CallExpression[] {
  return collect(ts.isCallExpression).filter(
    (call) => ts.isIdentifier(call.expression) && call.expression.text === name,
  );
}

describe("main.ts registers the Learn suppress handlers at startup (BACKLOG-4212)", () => {
  it(`imports ${FN} as a value from ${MODULE}`, () => {
    const imports = source.statements.filter(
      (s): s is ts.ImportDeclaration =>
        ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === MODULE,
    );
    expect(imports).toHaveLength(1);
    const clause = imports[0].importClause;
    expect(clause?.isTypeOnly).toBeFalsy();
    expect(clause?.namedBindings && ts.isNamedImports(clause.namedBindings)).toBe(true);
    const names = (clause?.namedBindings as ts.NamedImports).elements.map((e) => e.name.text);
    expect(names).toContain(FN);
  });

  it(`calls ${FN}() exactly once in main.ts`, () => {
    // Compared as source text: AST nodes are circular and cannot be printed.
    expect(callsTo(FN).map(text)).toEqual([`${FN}()`]);
  });

  it(`the call is a direct, unconditional statement of the app.whenReady() body`, () => {
    const handler = whenReadyHandler();
    expect(ts.isBlock(handler.body)).toBe(true);
    const body = handler.body as ts.Block;

    const calls = callsTo(FN);
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.arguments).toHaveLength(0);

    // The call's statement sits directly in the whenReady block: not inside a
    // nested function, an if/try/loop, or a callback that may never run.
    const statement = call.parent;
    expect(ts.isExpressionStatement(statement)).toBe(true);
    expect({ directlyInWhenReadyBody: statement.parent === body }).toEqual({ directlyInWhenReadyBody: true });

    // It runs after the BACKLOG-2962 stand-down guard, which is statement 0.
    const index = body.statements.indexOf(statement as ts.Statement);
    expect(index).toBeGreaterThan(0);
    expect(text(body.statements[0])).toBe("if (getStartupFailure()) return;");

    // No unconditional return/throw ahead of it in the same block.
    const earlyExit = body.statements
      .slice(0, index)
      .filter((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s));
    expect(earlyExit.map(text)).toEqual([]);
  });
});
