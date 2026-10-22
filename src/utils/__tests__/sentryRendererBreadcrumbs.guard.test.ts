/**
 * @jest-environment node
 */
/**
 * BACKLOG-4049 C3: AST guard over every non-test file in src/.
 *
 * The runtime allow-list (src/utils/sentryRendererBreadcrumbs.ts) is only as
 * complete as the set of Sentry calls the renderer makes. This guard fails when
 * a call site steps outside what that module lists:
 *
 *   (a) every addBreadcrumb is `Sentry.addBreadcrumb` (the namespace import, not a
 *       scope) with a LITERAL category that is in RENDERER_BREADCRUMB_CATEGORIES;
 *   (b) every breadcrumb `data` is an object literal whose keys are classified
 *       below (kept string, non-string, or dropped string). fdaTelemetry.ts:52
 *       passes `data: extra`; its keys are checked at its emit()/emitBoundary()
 *       call sites instead;
 *   (c) no stale entries: every listed category, string key and tag key is used;
 *   (d) exactly one Sentry.init in src/, in src/main.tsx, whose argument is an
 *       object literal with exactly `beforeBreadcrumb` and `integrations`, each
 *       read from a const set to `buildRendererSentryOptions(Sentry)` (imported
 *       from the module). The literal is kept for the BACKLOG-3801 check;
 *   (e) the only Sentry members used are addBreadcrumb, captureException,
 *       captureMessage, setTag (literal key in RENDERER_SCOPE_TAG_KEYS) and init.
 *       Any scope API call (setUser, setTags, setExtra, setExtras, setContext,
 *       withScope, getCurrentScope, getIsolationScope, getGlobalScope,
 *       addEventProcessor, ...) on ANY receiver fails, and the only allowed
 *       `@sentry/*` import is `import * as Sentry from "@sentry/electron/renderer"`.
 *
 * Exempt: the allow-list module itself, which reads scopes by design.
 *
 * Limits (stated, not solved): the guard cannot judge whether an entry ADDED to
 * a list is safe — that is a one-line diff in review. It does not follow the
 * Sentry namespace once passed to another function (only main.tsx may do that).
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import ts from "typescript";
import {
  RENDERER_BREADCRUMB_CATEGORIES,
  RENDERER_BREADCRUMB_STRING_KEYS,
  RENDERER_SCOPE_TAG_KEYS,
} from "../sentryRendererBreadcrumbs";

const REPO = path.resolve(__dirname, "..", "..", "..");
const MODULE_FILE = "src/utils/sentryRendererBreadcrumbs.ts";
const MAIN_FILE = "src/main.tsx";
const FDA_FILE = "src/components/onboarding/steps/fdaTelemetry.ts";

/** Data keys whose values are numbers or booleans at every call site. */
const NON_STRING_KEYS = new Set([
  "alreadyRunning",
  "attempt",
  "hadWarning",
  "hasDeviceApi",
  "hasEmailConnected",
  "hasPermissions",
  "hasSyncApi",
  "internalRunning",
  "isDatabaseInitialized",
  "isMacOS",
  "networkOnline",
  "progress",
  "queueLength",
  "queuePosition",
  "queueTotal",
  "timeInPreviousStage",
  "total_ms",
  "waited_ms",
  "will_retry",
]);
/** String keys that are present at call sites and dropped by the runtime filter. */
const DROPPED_STRING_KEYS = new Set(["error", "message", "userId"]);

const SENTRY_MEMBERS = new Set([
  "addBreadcrumb",
  "captureException",
  "captureMessage",
  "setTag",
  "init",
]);
const SCOPE_APIS = new Set([
  "setUser",
  "setTags",
  "setExtra",
  "setExtras",
  "setContext",
  "withScope",
  "withIsolationScope",
  "getCurrentScope",
  "getIsolationScope",
  "getGlobalScope",
  "addEventProcessor",
  "configureScope",
  "addAttachment",
  "setFingerprint",
]);

interface ScanResult {
  violations: string[];
  categories: Map<string, number>;
  dataKeys: Set<string>;
  tagKeys: Set<string>;
  inits: string[];
  breadcrumbSites: number;
}

function newResult(): ScanResult {
  return {
    violations: [],
    categories: new Map(),
    dataKeys: new Set(),
    tagKeys: new Set(),
    inits: [],
    breadcrumbSites: 0,
  };
}

function propName(p: ts.ObjectLiteralElementLike, sf: ts.SourceFile): string | null {
  if (ts.isShorthandPropertyAssignment(p)) return p.name.text;
  if (ts.isPropertyAssignment(p)) {
    if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) return p.name.text;
    return p.name.getText(sf);
  }
  return null;
}

function checkDataKeys(
  obj: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  at: string,
  out: ScanResult,
): void {
  for (const p of obj.properties) {
    const key = propName(p, sf);
    if (key === null) {
      out.violations.push(`${at} data has a spread or computed entry`);
      continue;
    }
    out.dataKeys.add(key);
    if (
      !RENDERER_BREADCRUMB_STRING_KEYS.has(key) &&
      !NON_STRING_KEYS.has(key) &&
      !DROPPED_STRING_KEYS.has(key)
    ) {
      out.violations.push(`${at} data key "${key}" is not classified`);
    }
  }
}

const INIT_KEYS = ["beforeBreadcrumb", "integrations"];

/** True when `const <name> = buildRendererSentryOptions(<sentry>)` is in the file. */
function isBuilderConst(name: string, sf: ts.SourceFile, sentry: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      ts.isVariableDeclarationList(n.parent) &&
      (n.parent.flags & ts.NodeFlags.Const) !== 0 &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      ts.isIdentifier(n.initializer.expression) &&
      n.initializer.expression.text === "buildRendererSentryOptions" &&
      n.initializer.arguments.length === 1 &&
      ts.isIdentifier(n.initializer.arguments[0]) &&
      n.initializer.arguments[0].text === sentry
    ) {
      found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function isWiredInit(call: ts.CallExpression, sf: ts.SourceFile, sentry: string): boolean {
  const a = call.arguments[0];
  if (call.arguments.length !== 1 || !a || !ts.isObjectLiteralExpression(a)) return false;
  if (a.properties.length !== INIT_KEYS.length) return false;
  let source: string | null = null;
  for (const p of a.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) return false;
    const key = p.name.text;
    const v = p.initializer;
    if (!INIT_KEYS.includes(key)) return false;
    if (!ts.isPropertyAccessExpression(v) || !ts.isIdentifier(v.expression) || v.name.text !== key) {
      return false;
    }
    if (source !== null && source !== v.expression.text) return false;
    source = v.expression.text;
  }
  return source !== null && isBuilderConst(source, sf, sentry);
}

export function scanSource(file: string, text: string, out: ScanResult = newResult()): ScanResult {
  if (file === MODULE_FILE) return out;
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineOf = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  let sentryLocal: string | null = null;
  let importsBuilder = false;

  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (spec.endsWith("/sentryRendererBreadcrumbs")) {
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb) && nb.elements.some((e) => e.name.text === "buildRendererSentryOptions")) {
        importsBuilder = true;
      }
    }
    if (!spec.startsWith("@sentry/")) continue;
    if (st.importClause?.isTypeOnly) continue;
    const nb = st.importClause?.namedBindings;
    if (
      spec === "@sentry/electron/renderer" &&
      nb &&
      ts.isNamespaceImport(nb) &&
      !st.importClause?.name &&
      nb.name.text === "Sentry"
    ) {
      sentryLocal = "Sentry";
    } else {
      out.violations.push(`${lineOf(st)} import from "${spec}" must be \`import * as Sentry from "@sentry/electron/renderer"\``);
    }
  }

  const walk = (n: ts.Node): void => {
    if (
      (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) ||
      (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require")
    ) {
      const a = n.arguments[0];
      if (a && ts.isStringLiteralLike(a) && a.text.startsWith("@sentry/")) {
        out.violations.push(`${lineOf(n)} dynamic import/require of "${a.text}"`);
      }
    }

    if (sentryLocal && ts.isIdentifier(n) && n.text === sentryLocal) {
      const parent = n.parent;
      const isImportName = ts.isNamespaceImport(parent);
      const isReceiver = ts.isPropertyAccessExpression(parent) && parent.expression === n;
      const isBuilderArg =
        file === MAIN_FILE &&
        ts.isCallExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === "buildRendererSentryOptions";
      if (!isImportName && !isReceiver && !isBuilderArg) {
        out.violations.push(`${lineOf(n)} the Sentry namespace is used as a value`);
      }
      if (isReceiver) {
        const member = (parent as ts.PropertyAccessExpression).name.text;
        if (!SENTRY_MEMBERS.has(member)) {
          out.violations.push(`${lineOf(n)} Sentry.${member} is not allowed in the renderer`);
        }
      }
    }

    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const recv = n.expression.expression;
      const onSentry = !!sentryLocal && ts.isIdentifier(recv) && recv.text === sentryLocal;
      const at = lineOf(n);

      if (SCOPE_APIS.has(method)) {
        out.violations.push(`${at} scope API .${method}() is not allowed in the renderer`);
      }

      if (method === "setTag") {
        const key = n.arguments[0];
        if (!onSentry) {
          out.violations.push(`${at} setTag on a receiver other than the Sentry namespace`);
        } else if (!key || !ts.isStringLiteralLike(key)) {
          out.violations.push(`${at} setTag key is not a string literal`);
        } else {
          out.tagKeys.add(key.text);
          if (!RENDERER_SCOPE_TAG_KEYS.has(key.text)) {
            out.violations.push(`${at} setTag key "${key.text}" is not in RENDERER_SCOPE_TAG_KEYS`);
          }
        }
      }

      if (method === "addBreadcrumb") {
        out.breadcrumbSites++;
        if (!onSentry) {
          out.violations.push(`${at} addBreadcrumb on a receiver other than the Sentry namespace`);
        }
        const arg = n.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) {
          out.violations.push(`${at} addBreadcrumb argument is not an object literal`);
        } else {
          let category: string | null = null;
          for (const p of arg.properties) {
            const key = propName(p, sf);
            if (key === null) {
              out.violations.push(`${at} addBreadcrumb has a spread or computed entry`);
              continue;
            }
            if (key === "category") {
              if (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)) {
                category = p.initializer.text;
              }
            }
            if (key === "data" && ts.isPropertyAssignment(p)) {
              if (ts.isObjectLiteralExpression(p.initializer)) {
                checkDataKeys(p.initializer, sf, at, out);
              } else if (!(file === FDA_FILE && p.initializer.getText(sf) === "extra")) {
                out.violations.push(`${at} breadcrumb data is not an object literal`);
              }
            }
          }
          if (category === null) {
            out.violations.push(`${at} breadcrumb category is not a string literal`);
          } else {
            out.categories.set(category, (out.categories.get(category) ?? 0) + 1);
            if (!RENDERER_BREADCRUMB_CATEGORIES.has(category)) {
              out.violations.push(`${at} breadcrumb category "${category}" is not in RENDERER_BREADCRUMB_CATEGORIES`);
            }
          }
        }
      }

      if (method === "init" && onSentry) {
        out.inits.push(at);
        if (!(file === MAIN_FILE && importsBuilder && isWiredInit(n, sf, sentryLocal as string))) {
          out.violations.push(
            `${at} Sentry.init must be Sentry.init({ beforeBreadcrumb: o.beforeBreadcrumb, integrations: o.integrations }) with const o = buildRendererSentryOptions(Sentry), in ${MAIN_FILE}`,
          );
        }
      }
    }

    // fdaTelemetry: emit()/emitBoundary() carry the breadcrumb data.
    if (
      file === FDA_FILE &&
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      (n.expression.text === "emit" || n.expression.text === "emitBoundary")
    ) {
      const extra = n.arguments[1];
      if (extra && ts.isObjectLiteralExpression(extra)) checkDataKeys(extra, sf, lineOf(n), out);
      else if (extra && !(ts.isIdentifier(extra) && extra.text === "extra")) {
        out.violations.push(`${lineOf(n)} ${n.expression.text}() data is not an object literal`);
      }
    }

    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src/**/*.ts", "src/**/*.tsx", "src/*.ts", "src/*.tsx"], {
    cwd: REPO,
  })
    .toString()
    .trim()
    .split("\n")
    .filter((f) => f && !/\.test\.|__tests__|__mocks__/.test(f));
}

function scanTree(): ScanResult {
  const out = newResult();
  for (const f of sourceFiles()) {
    const abs = path.join(REPO, f);
    if (!fs.existsSync(abs)) continue;
    scanSource(f, fs.readFileSync(abs, "utf8"), out);
  }
  return out;
}

describe("renderer Sentry call-site guard", () => {
  const tree = scanTree();

  it("scans a non-trivial tree (positive control)", () => {
    expect(sourceFiles().length).toBeGreaterThan(500);
    expect(tree.breadcrumbSites).toBeGreaterThanOrEqual(28);
  });

  it("(a, b, d, e) finds no call site outside the allow-list", () => {
    expect(tree.violations).toEqual([]);
  });

  it("(c) every listed category, string key and tag key is used", () => {
    expect([...RENDERER_BREADCRUMB_CATEGORIES].filter((c) => !tree.categories.has(c))).toEqual([]);
    expect([...RENDERER_BREADCRUMB_STRING_KEYS].filter((k) => !tree.dataKeys.has(k))).toEqual([]);
    expect([...RENDERER_SCOPE_TAG_KEYS].filter((k) => !tree.tagKeys.has(k))).toEqual([]);
  });

  it("(d) exactly one Sentry.init, in src/main.tsx", () => {
    expect(tree.inits).toHaveLength(1);
    expect(tree.inits[0].startsWith(`${MAIN_FILE}:`)).toBe(true);
  });
});

describe("guard self-test: each new scope call is reported", () => {
  const header = 'import * as Sentry from "@sentry/electron/renderer";\n';
  const cases: Array<[string, string]> = [
    ["scope-level addBreadcrumb", 'Sentry.getCurrentScope().addBreadcrumb({ category: "sync" });'],
    ["setExtra", 'Sentry.setExtra("x", "y");'],
    ["setExtras", 'Sentry.setExtras({ x: "y" });'],
    ["setContext", 'Sentry.setContext("c", { a: 1 });'],
    ["setUser", 'Sentry.setUser({ id: "1", email: "a@example.com" });'],
    ["setTags", 'Sentry.setTags({ a: "b" });'],
    ["withScope", "Sentry.withScope(() => {});"],
    ["getIsolationScope", 'Sentry.getIsolationScope().setTag("a", "b");'],
    ["getGlobalScope", "Sentry.getGlobalScope();"],
    ["addEventProcessor", "Sentry.addEventProcessor((e) => e);"],
    ["setTag with an unlisted key", 'Sentry.setTag("contact", "x");'],
    ["setTag with a computed key", "Sentry.setTag(k, v);"],
    ["setTag on a scope", '(s as any).setTag("init_stage", "x");'],
    ["unlisted category", 'Sentry.addBreadcrumb({ category: "contacts.debug" });'],
    ["computed category", "Sentry.addBreadcrumb({ category: c });"],
    ["unclassified data key", 'Sentry.addBreadcrumb({ category: "sync", data: { name: n } });'],
    ["opaque data", 'Sentry.addBreadcrumb({ category: "sync", data: d });'],
    ["other Sentry member", "Sentry.captureEvent({});"],
    ["namespace passed as a value", "register(Sentry);"],
    ["Sentry.init outside main.tsx", "Sentry.init({});"],
  ];
  it.each(cases)("%s", (_label, body) => {
    expect(scanSource("src/probe/Fixture.ts", header + body).violations.length).toBeGreaterThan(0);
  });

  it("named @sentry imports are reported", () => {
    const r = scanSource("src/probe/Fixture.ts", 'import { setUser } from "@sentry/browser";\nsetUser(null);');
    expect(r.violations.length).toBeGreaterThan(0);
  });

  it("an allowed call is not reported", () => {
    const r = scanSource(
      "src/probe/Fixture.ts",
      header +
        'Sentry.addBreadcrumb({ category: "sync", message: "m", data: { attempt: 1, stage: "s" } });\n' +
        'Sentry.setTag("init_stage", stage);\n',
    );
    expect(r.violations).toEqual([]);
  });
});
