/**
 * @jest-environment node
 */

/**
 * BACKLOG-3299: sessionService.saveSession and saveSignInSession report a
 * failed session-file write as `false` (they never reject). A caller that
 * drops that boolean logs or answers "saved" for a write that did not happen.
 *
 * This reads every production .ts file under electron/ with the TypeScript
 * parser (not regex, so a call split across lines is still found) and checks
 * every call of either function:
 *
 *   G0  the scanner finds exactly the known calls (positive control).
 *   G1  each call's result is used in one of the ALLOWED shapes below;
 *       anything else fails.
 *   G2  the discard allow-list is exactly the three dead in-app OAuth sites,
 *       each tied to BACKLOG-4103, and each still matches a call.
 *   G3  saveSignInSession is called only by the two deep-link sign-in
 *       writers (BACKLOG-4076).
 *   G4  main.ts logs "Session saved successfully" only inside the branch
 *       where the saveSignInSession result is true (main.ts has no unit
 *       harness, so nothing else can see an unconditional success line).
 *
 * ALLOWED shapes (the call must be awaited first):
 *   const x = await f(...)      where x is read later in the same function
 *   return await f(...)
 *   if (await f(...)) / if (!(await f(...)))   (also a ?: condition)
 * Everything else fails G1: a bare `await f(...)`, `void f(...)`,
 * `f(...).then(...)`, `f(...).catch(...)`, `f(...).finally(...)`,
 * `Promise.all([f(...)])`, passing the promise as an argument, assigning to an
 * existing variable, and an un-awaited `const p = f(...)`.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";
import ts from "typescript";

const ROOT = path.join(__dirname, "..", "..");
const NAMES = new Set(["saveSession", "saveSignInSession"]);

/**
 * Calls allowed to discard the result. All three are the in-app OAuth login
 * path, which has no caller in src/; whether to wire it, remove it or keep it
 * is open on BACKLOG-4103. Keyed by file + top-level function.
 */
const ALLOW_DISCARD: ReadonlyArray<{ key: string; item: string }> = [
  // BACKLOG-4103: dead in-app Google login
  { key: "electron/handlers/googleAuthHandlers.ts#handleGoogleLogin", item: "BACKLOG-4103" },
  // BACKLOG-4103: dead in-app Google complete-login
  { key: "electron/handlers/googleAuthHandlers.ts#handleGoogleCompleteLogin", item: "BACKLOG-4103" },
  // BACKLOG-4103: dead in-app Microsoft login
  { key: "electron/handlers/microsoftAuthHandlers.ts#handleMicrosoftLogin", item: "BACKLOG-4103" },
];
const ALLOW_KEYS = new Set(ALLOW_DISCARD.map((a) => a.key));

const SIGN_IN_WRITERS = new Set([
  "electron/main.ts#handleDeepLinkCallback",
  "electron/handlers/systemHandlers.ts#persistSessionForUser",
]);

/** Known call counts. Change deliberately when a call is added or removed. */
const EXPECTED_CALLS = { saveSession: 6, saveSignInSession: 2 };

function read(rel: string): string {
  // Windows checkouts use CRLF (BACKLOG-3555).
  return readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

function productionFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--", "electron"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .filter(
      (f) =>
        /\.(ts|tsx)$/.test(f) &&
        !/\.d\.ts$/.test(f) &&
        !/(__tests__|__mocks__|\.test\.|\.spec\.)/.test(f),
    );
}

type Site = { key: string; where: string; name: string; problem: string | null };

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n)
  );
}

function enclosingFn(n: ts.Node): ts.Node | undefined {
  for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
  return undefined;
}

function topFnName(n: ts.Node): string {
  let name = "<module>";
  for (let p = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) name = p.name.getText();
    else if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent))
      name = p.parent.name.getText();
  }
  return name;
}

function calleeName(c: ts.LeftHandSideExpression): string | undefined {
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isElementAccessExpression(c) && ts.isStringLiteralLike(c.argumentExpression))
    return c.argumentExpression.text;
  return undefined;
}

/** Number of reads of `decl` inside `scope` that use the value (not `void x;` or a bare `x;`). */
function countReads(scope: ts.Node, decl: ts.Identifier): number {
  let reads = 0;
  const look = (m: ts.Node): void => {
    if (ts.isIdentifier(m) && m !== decl && m.text === decl.text) {
      const parent = m.parent;
      const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === m;
      const isPropertyKey = ts.isPropertyAssignment(parent) && parent.name === m;
      const isIgnored = ts.isVoidExpression(parent) || ts.isExpressionStatement(parent);
      if (!isMemberName && !isPropertyKey && !isIgnored) reads++;
    }
    ts.forEachChild(m, look);
  };
  look(scope);
  return reads;
}

/** null when the call's result is used in an allowed shape, otherwise why not. */
function classify(call: ts.CallExpression, sf: ts.SourceFile): string | null {
  let cur: ts.Node = call;
  let awaited = false;
  let negated = false;
  for (;;) {
    const p = cur.parent;
    if (ts.isParenthesizedExpression(p)) cur = p;
    else if (ts.isAwaitExpression(p) && !awaited) {
      awaited = true;
      cur = p;
    } else if (awaited && ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) {
      negated = true;
      cur = p;
    } else break;
  }
  const p = cur.parent;
  if (!awaited) return `not awaited (parent: ${ts.SyntaxKind[p.kind]})`;
  if (ts.isIfStatement(p) && p.expression === cur) return null;
  if (ts.isConditionalExpression(p) && p.condition === cur) return null;
  if (negated) return `negated outside a condition (parent: ${ts.SyntaxKind[p.kind]})`;
  if (ts.isReturnStatement(p)) return null;
  if (ts.isVariableDeclaration(p) && p.initializer === cur) {
    if (!ts.isIdentifier(p.name)) return "destructured result";
    const reads = countReads(enclosingFn(call) ?? sf, p.name);
    return reads > 0 ? null : `result bound to "${p.name.text}" and never read`;
  }
  if (ts.isExpressionStatement(p)) return "result discarded (bare await)";
  return `result not used in an allowed shape (parent: ${ts.SyntaxKind[p.kind]})`;
}

function sites(): Site[] {
  const found: Site[] = [];
  for (const rel of productionFiles()) {
    const text = read(rel);
    if (!/saveSession|saveSignInSession/.test(text)) continue;
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n.expression);
        if (name && NAMES.has(name)) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
          found.push({ key: `${rel}#${topFnName(n)}`, where: `${rel}:${line}`, name, problem: classify(n, sf) });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return found;
}

describe("BACKLOG-3299: every production saveSession / saveSignInSession call uses its result", () => {
  const all = sites();

  it("G0 the scanner finds exactly the known calls", () => {
    expect({
      saveSession: all.filter((s) => s.name === "saveSession").length,
      saveSignInSession: all.filter((s) => s.name === "saveSignInSession").length,
    }).toEqual(EXPECTED_CALLS);
  });

  it("G1 every call outside the allow-list uses the result in an allowed shape", () => {
    expect(
      all.filter((s) => s.problem && !ALLOW_KEYS.has(s.key)).map((s) => `${s.where} ${s.problem}`),
    ).toEqual([]);
  });

  it("G2 the allow-list is exactly the three BACKLOG-4103 sites, each still present", () => {
    expect(ALLOW_DISCARD).toHaveLength(3);
    expect(ALLOW_KEYS.size).toBe(3);
    expect(ALLOW_DISCARD.filter((a) => a.item !== "BACKLOG-4103").map((a) => a.key)).toEqual([]);
    // Each entry carries its "// BACKLOG-4103" comment in this file.
    const self = readFileSync(__filename, "utf8").replace(/\r\n/g, "\n").split("\n");
    for (const { key } of ALLOW_DISCARD) {
      const i = self.findIndex((l) => l.includes(`key: "${key}"`));
      expect([key, i >= 1 && /\/\/ BACKLOG-4103\b/.test(self[i - 1])]).toEqual([key, true]);
    }
    for (const { key } of ALLOW_DISCARD) expect([key, all.some((s) => s.key === key)]).toEqual([key, true]);
  });

  it("G3 saveSignInSession is called only by the two deep-link sign-in writers", () => {
    expect(
      all.filter((s) => s.name === "saveSignInSession").map((s) => s.key).sort(),
    ).toEqual([...SIGN_IN_WRITERS].sort());
  });

  it("G4 main.ts logs the session-saved line only when saveSignInSession returned true", () => {
    const rel = "electron/main.ts";
    const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
    let bound: string | undefined;
    let seen = 0;
    let guarded = 0;
    const visit = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        /saveSignInSession\(/.test(n.initializer.getText())
      )
        bound = n.name.text;
      if (
        ts.isCallExpression(n) &&
        n.arguments.some((a) => ts.isStringLiteralLike(a) && a.text.includes("Session saved successfully"))
      ) {
        seen++;
        for (let p = n.parent; p; p = p.parent) {
          if (!bound) break;
          const test = ts.isIfStatement(p) ? p.expression : ts.isConditionalExpression(p) ? p.condition : undefined;
          const branch = ts.isIfStatement(p) ? p.thenStatement : ts.isConditionalExpression(p) ? p.whenTrue : undefined;
          if (
            test &&
            branch &&
            ts.isIdentifier(test) &&
            test.text === bound &&
            branch.getStart() <= n.getStart() &&
            n.getEnd() <= branch.getEnd()
          ) {
            guarded++;
            break;
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(bound).toBeDefined();
    expect(seen).toBe(1);
    expect(guarded).toBe(1);
  });
});
