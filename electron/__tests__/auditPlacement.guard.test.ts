/**
 * @jest-environment node
 *
 * BACKLOG-3339 — WHERE AN AUDIT ENTRY MAY BE WRITTEN.
 *
 * ===========================================================================
 * THE RULE
 * ===========================================================================
 * An audit entry for a LOCAL change is written inside that change's
 * transaction, with `auditService.recordInTransaction`, so the change and its
 * entry commit together or not at all. `auditService.log` writes after the
 * fact and swallows its own failure; it is allowed only at the sites listed in
 * ALLOWLIST below, each with a reason.
 *
 *   1. Every `log(` call on the auditService import must match an ALLOWLIST
 *      key, with EXACTLY the listed count. A new call, or a second call in a
 *      listed handler, is red.
 *   2. The ALLOWLIST is shrink-only: a key that matches no call is red. When a
 *      site is converted, its entry is deleted in the same PR.
 *   3. Every `recordInTransaction(` call must sit LEXICALLY in a transaction
 *      body: its nearest enclosing function is the callback passed to
 *      `dbTransaction(...)` or `.transaction(...)`, or a function named
 *      `*Sync` (a synchronous core that is called from a body). A call inside
 *      a nested callback — `setTimeout`, `.then`, an `async` arrow — is red.
 *   4. `withAudit` no longer exists; any call to it is red.
 *
 * ===========================================================================
 * WHAT THIS DOES NOT PROVE — STATED, NOT IMPLIED
 * ===========================================================================
 * - The runtime check is `recordInTransaction`'s own `inTransaction` assert:
 *   it throws when no transaction is open on the audit connection. This guard
 *   only detects drift in the source; it cannot see a `*Sync` helper that is
 *   called from outside a transaction (the runtime assert does).
 * - The db-layer write guard (`writeAtomicity.guard.test.ts`) does NOT see
 *   converted sites. A converted site calls a SERVICE method
 *   (`auditService.recordInTransaction`), and that guard counts service
 *   methods as zero writes (measured: pm_comments e3750ee4, M11). This file
 *   is the only static check on audit placement.
 *
 * ===========================================================================
 * KEYS
 * ===========================================================================
 * `<file>::<channel or function>::<action>`. The channel is the string literal
 * of the nearest enclosing call whose first argument looks like an IPC channel
 * (`"transactions:update"`), reached through `wrapHandler` / `handleBusy`.
 * Outside a handler it is the nearest named function. Never a line number: a
 * line-keyed list churns on every edit above it. A site that resolves to no
 * key is red.
 *
 * Every call form on the import binding is seen: any local name (default or
 * aliased named import), `.log`, `?.log`, `["log"]`. Destructuring the binding
 * or copying it into another variable is red, because a call through the copy
 * would be invisible.
 */

import fs from "fs";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCAN_ROOT = path.join(REPO_ROOT, "electron");
const AUDIT_SERVICE_FILE = "electron/services/auditService.ts";

/**
 * Audit sites written with `auditService.log` today: 37 (BACKLOG-3339 plan,
 * pm_comments 7e81dd50, re-counted by this walk; 39 until the unused
 * `transactions:create` and `contacts:delete` channels were removed). `log` calls plus
 * `recordInTransaction` calls must add up to this. A conversion moves a site
 * from one side to the other; a NEW audited site changes the total and must
 * update this number on purpose.
 */
const AUDITED_SITES_TOTAL = 37;

type Reason = string;
const R_EXPORT = "BACKLOG-3339 export slice; waits on the founder's export ruling";
const R_SLICE2 = "BACKLOG-3339 slice 2 converts (deal detail toggles); seam check pending";
const R_SLICE3 = "BACKLOG-3339 slice 3 converts (contacts, settings)";
const R_REMOTE =
  "record-only: the change is a cloud write, which cannot share a local transaction";
const R_SESSION =
  "record-only: sign-in/session/mailbox; no local change to pair with and the database may be closed (BACKLOG-3340)";
const R_READ = "record-only: records a read, there is no change to pair with";
const R_UNREACHABLE = "no UI caller; waits on the founder's wire/delete ruling (BACKLOG-3339 plan §1 F)";

/** Shrink-only. Key -> exact number of `log(` calls, and why it may stay. */
const ALLOWLIST: Record<string, { count: number; reason: Reason }> = {
  // A — deal / compliance
  "electron/handlers/transactionCrudHandlers.ts::transactions:restore-contact::TRANSACTION_UPDATE": { count: 1, reason: R_SLICE2 },
  "electron/services/exportCompletion.ts::completeExport::DATA_EXPORT": { count: 1, reason: R_EXPORT },
  "electron/handlers/hiddenTextHandlers.ts::transactions:hide-text-from-export::TRANSACTION_UPDATE": { count: 1, reason: R_SLICE2 },
  "electron/handlers/hiddenTextHandlers.ts::transactions:unhide-text-from-export::TRANSACTION_UPDATE": { count: 1, reason: R_SLICE2 },
  "electron/handlers/checklistHandlers.ts::auditChecklistAct::TRANSACTION_UPDATE": { count: 1, reason: R_SLICE2 },
  // B — contacts, C1 — local setting
  "electron/handlers/contactHandlers.ts::contacts:create::CONTACT_CREATE": { count: 1, reason: R_SLICE3 },
  "electron/handlers/contactHandlers.ts::contacts:update::CONTACT_UPDATE": { count: 1, reason: R_SLICE3 },
  "electron/handlers/contactHandlers.ts::contacts:remove::CONTACT_DELETE": { count: 1, reason: R_SLICE3 },
  "electron/handlers/contactHandlers.ts::contacts:restore::CONTACT_UPDATE": { count: 1, reason: R_SLICE3 },
  "electron/handlers/userSettingsHandlers.ts::user:set-phone-type::SETTINGS_CHANGE": { count: 1, reason: R_SLICE3 },
  // C2, D — remote changes
  "electron/handlers/userSettingsHandlers.ts::user:set-phone-type-cloud::SETTINGS_CHANGE": { count: 1, reason: R_REMOTE },
  "electron/handlers/transactionExportHandlers.ts::transactions:submit::TRANSACTION_SUBMIT": { count: 1, reason: R_REMOTE },
  "electron/handlers/transactionExportHandlers.ts::transactions:resubmit::TRANSACTION_SUBMIT": { count: 1, reason: R_REMOTE },
  // E — sign-in, session, mailbox; and one read
  "electron/handlers/googleAuthHandlers.ts::handleGoogleCompleteLogin::LOGIN": { count: 1, reason: R_SESSION },
  "electron/handlers/googleAuthHandlers.ts::processLoginInBackground::MAILBOX_CONNECT": { count: 3, reason: R_SESSION },
  "electron/handlers/microsoftAuthHandlers.ts::processAuthInBackground::LOGIN": { count: 1, reason: R_SESSION },
  "electron/handlers/microsoftAuthHandlers.ts::processAuthInBackground::LOGIN_FAILED": { count: 1, reason: R_SESSION },
  "electron/handlers/microsoftAuthHandlers.ts::processAuthInBackground::MAILBOX_CONNECT": { count: 3, reason: R_SESSION },
  "electron/handlers/sharedAuthHandlers.ts::handleCompletePendingLogin::LOGIN_FAILED": { count: 1, reason: R_SESSION },
  "electron/handlers/sharedAuthHandlers.ts::handleCompletePendingLogin::LOGIN": { count: 1, reason: R_SESSION },
  "electron/handlers/sharedAuthHandlers.ts::handleSavePendingMailboxTokens::MAILBOX_CONNECT": { count: 1, reason: R_SESSION },
  "electron/handlers/sharedAuthHandlers.ts::handleDisconnectMailbox::MAILBOX_DISCONNECT": { count: 2, reason: R_SESSION },
  "electron/handlers/sessionHandlers.ts::handleSignOutAllDevices::LOGOUT": { count: 1, reason: R_SESSION },
  "electron/handlers/sessionSignOut.ts::signOutLocalSession::LOGOUT": { count: 1, reason: R_SESSION },
  "electron/handlers/attachmentHandlers.ts::auditAttachmentAccess::DATA_ACCESS": { count: 1, reason: R_READ },
  // F — no UI caller
  "electron/handlers/transactionExportHandlers.ts::transactions:export-pdf::DATA_EXPORT": { count: 1, reason: R_UNREACHABLE },
  "electron/services/transactionService/transactionService.ts::adminUnfreezeTransaction::TRANSACTION_UPDATE": { count: 1, reason: R_UNREACHABLE },
};

// ---------------------------------------------------------------------------
// The walk. Pure functions over source text, so the fixtures below exercise
// the same code as the tree.
// ---------------------------------------------------------------------------

const AUDIT_METHODS = new Set(["log", "withAudit", "recordInTransaction", "recordFailure"]);
const CHANNEL_RE = /^[a-z][\w-]*(:[\w-]+)+$/;

export interface AuditSite {
  file: string;
  line: number;
  method: string;
  key: string | null;
}

export interface Analysis {
  sites: AuditSite[];
  problems: string[];
}

function isAuditModule(spec: string): boolean {
  return /(^|\/)auditService$/.test(spec);
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

function functionName(fn: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    return fn.name.getText();
  }
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parent) {
    if (ts.isFunctionExpression(fn) && fn.name) return fn.name.getText();
    const p = fn.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isPropertyAssignment(p)) return p.name.getText();
    if (ts.isPropertyDeclaration(p)) return p.name.getText();
  }
  return null;
}

function stringArg(call: ts.CallExpression): string | null {
  const a = call.arguments[0];
  if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) return a.text;
  return null;
}

/** The IPC channel of the nearest enclosing handler registration, or the nearest named function. */
function siteScope(node: ts.Node): string | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p)) {
      const s = stringArg(p);
      if (s && CHANNEL_RE.test(s)) return s;
    }
  }
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (isFunctionLike(p)) {
      const name = functionName(p);
      if (name) return name;
    }
  }
  return null;
}

function actionOf(call: ts.CallExpression): string {
  const a = call.arguments[0];
  if (a && ts.isObjectLiteralExpression(a)) {
    for (const prop of a.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name.getText() === "action") {
        const v = prop.initializer;
        if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) return v.text;
        if (ts.isAsExpression(v) && ts.isStringLiteral(v.expression)) return v.expression.text;
        return `<${v.getText()}>`;
      }
    }
  }
  return "<no action>";
}

/** Is `fn` the callback of `dbTransaction(...)` / `x.transaction(...)`? */
function isTransactionBody(fn: ts.Node): boolean {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== fn) return false;
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "dbTransaction";
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "transaction";
  return false;
}

export function analyzeSource(file: string, text: string): Analysis {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = new Set<string>();
  const problems: string[] = [];
  const sites: AuditSite[] = [];

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!isAuditModule(stmt.moduleSpecifier.text)) continue;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) bindings.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) {
      problems.push(`${file}: namespace import of auditService — use the default or named import`);
    } else if (nb) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue;
        const imported = (el.propertyName ?? el.name).text;
        if (imported === "auditService" || imported === "default") bindings.add(el.name.text);
      }
    }
  }
  if (bindings.size === 0) return { sites, problems };

  const where = (n: ts.Node) =>
    `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

  const visit = (n: ts.Node): void => {
    // Copies of the binding hide every call made through them.
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.initializer) && bindings.has(n.initializer.text)) {
      problems.push(`${where(n)}: auditService is copied or destructured; call it directly`);
    }

    let method: string | null = null;
    let access: ts.Expression | null = null;
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && bindings.has(n.expression.text)) {
      method = n.name.text;
      access = n;
    } else if (
      ts.isElementAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      bindings.has(n.expression.text)
    ) {
      const arg = n.argumentExpression;
      method = ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : `<${arg.getText()}>`;
      access = n;
    }

    if (method && access && (AUDIT_METHODS.has(method) || method.startsWith("<"))) {
      const call = access.parent;
      if (!call || !ts.isCallExpression(call) || call.expression !== access) {
        problems.push(`${where(access)}: auditService.${method} is referenced without being called`);
      } else if (method === "withAudit") {
        problems.push(`${where(call)}: withAudit was removed (BACKLOG-3339); use recordInTransaction + recordFailure`);
      } else if (method.startsWith("<")) {
        problems.push(`${where(call)}: computed auditService member ${method}`);
      } else if (method === "log" || method === "recordInTransaction") {
        const scope = siteScope(call);
        const key = scope ? `${file}::${scope}::${actionOf(call)}` : null;
        if (!key) problems.push(`${where(call)}: audit site resolves to no channel or named function`);
        sites.push({ file, line: sf.getLineAndCharacterOfPosition(call.getStart()).line + 1, method, key });

        if (method === "recordInTransaction") {
          let fn: ts.Node | undefined = call.parent;
          while (fn && !isFunctionLike(fn)) fn = fn.parent;
          const ok =
            !!fn &&
            !(fn as ts.FunctionLikeDeclaration).modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) &&
            (isTransactionBody(fn) || /Sync$/.test(functionName(fn) ?? ""));
          if (!ok) {
            problems.push(
              `${where(call)}: recordInTransaction is not directly inside a dbTransaction(...) body or a *Sync function`,
            );
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { sites, problems };
}

export function checkAllowlist(
  sites: AuditSite[],
  allowlist: Record<string, { count: number; reason: Reason }>,
): string[] {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const s of sites) {
    if (s.method !== "log" || !s.key) continue;
    counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  }
  for (const [key, n] of counts) {
    const entry = allowlist[key];
    if (!entry) problems.push(`not on the allowlist: ${key} (${n} log call(s)) — write it with recordInTransaction`);
    else if (entry.count !== n) problems.push(`count changed: ${key} has ${n} log call(s), allowlist says ${entry.count}`);
  }
  for (const [key, entry] of Object.entries(allowlist)) {
    if (!counts.has(key)) problems.push(`stale allowlist entry (shrink-only — delete it): ${key}`);
    if (!entry.reason.trim()) problems.push(`allowlist entry has no reason: ${key}`);
  }
  return problems;
}

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "__tests__" || ent.name === "__typefixtures__" || ent.name === "node_modules") continue;
        walk(full);
      } else if (/\.tsx?$/.test(ent.name) && !/\.(test|spec)\.tsx?$/.test(ent.name) && !ent.name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  };
  walk(SCAN_ROOT);
  return out;
}

function analyzeTree(): { files: number; sites: AuditSite[]; problems: string[] } {
  const files = productionFiles();
  const sites: AuditSite[] = [];
  const problems: string[] = [];
  for (const full of files) {
    const rel = path.relative(REPO_ROOT, full).split(path.sep).join("/");
    if (rel === AUDIT_SERVICE_FILE) continue;
    const text = fs.readFileSync(full, "utf8");
    if (!text.includes("auditService")) continue;
    const a = analyzeSource(rel, text);
    sites.push(...a.sites);
    problems.push(...a.problems);
  }
  return { files: files.length, sites, problems };
}

describe("audit placement (BACKLOG-3339)", () => {
  const tree = analyzeTree();

  it("scans the tree (not vacuous)", () => {
    expect(tree.files).toBeGreaterThan(100);
    expect(tree.sites.filter((s) => s.method === "log").length).toBeGreaterThan(0);
  });

  it("every audit call form on the auditService import is a call the guard can key", () => {
    expect(tree.problems).toEqual([]);
  });

  it("every auditService.log call is on the shrink-only allowlist with its exact count", () => {
    expect(checkAllowlist(tree.sites, ALLOWLIST)).toEqual([]);
  });

  it("log + recordInTransaction sites add up to the known total", () => {
    expect(tree.sites.length).toBe(AUDITED_SITES_TOTAL);
  });

  // -------------------------------------------------------------------------
  // Fixture controls: each shape the guard exists to catch goes red.
  // -------------------------------------------------------------------------
  describe("fixtures", () => {
    const H = `import auditService from "../services/auditService";\n`;
    const handler = (body: string) =>
      `${H}ipcMain.handle("things:do", wrapHandler(async () => {\n${body}\n}));\n`;
    const LOG = `await auditService.log({ userId: "u", action: "TRANSACTION_UPDATE", resourceType: "TRANSACTION", success: true });`;

    it("a log call that is not on the allowlist is red", () => {
      const a = analyzeSource("fx/a.ts", handler(LOG));
      expect(a.problems).toEqual([]);
      expect(a.sites.map((s) => s.key)).toEqual(["fx/a.ts::things:do::TRANSACTION_UPDATE"]);
      expect(checkAllowlist(a.sites, {})).toEqual([
        "not on the allowlist: fx/a.ts::things:do::TRANSACTION_UPDATE (1 log call(s)) — write it with recordInTransaction",
      ]);
    });

    it("a second log call in an allowlisted handler is red", () => {
      const a = analyzeSource("fx/a.ts", handler(`${LOG}\n${LOG}`));
      expect(
        checkAllowlist(a.sites, { "fx/a.ts::things:do::TRANSACTION_UPDATE": { count: 1, reason: "x" } }),
      ).toEqual(["count changed: fx/a.ts::things:do::TRANSACTION_UPDATE has 2 log call(s), allowlist says 1"]);
    });

    it("a stale allowlist key is red", () => {
      expect(checkAllowlist([], { "fx/gone.ts::things:gone::LOGIN": { count: 1, reason: "x" } })).toEqual([
        "stale allowlist entry (shrink-only — delete it): fx/gone.ts::things:gone::LOGIN",
      ]);
    });

    it("recordInTransaction directly in a dbTransaction body, or in a *Sync core, is green", () => {
      const a = analyzeSource(
        "fx/b.ts",
        handler(
          `dbTransaction(() => { auditService.recordInTransaction({ userId: "u", action: "TRANSACTION_UPDATE", resourceType: "TRANSACTION" }); });`,
        ) +
          `function writeThingSync() { auditService.recordInTransaction({ userId: "u", action: "TRANSACTION_UPDATE", resourceType: "TRANSACTION" }); }\n`,
      );
      expect(a.problems).toEqual([]);
      expect(a.sites.map((s) => s.method)).toEqual(["recordInTransaction", "recordInTransaction"]);
    });

    it("recordInTransaction outside a transaction is red", () => {
      const a = analyzeSource(
        "fx/c.ts",
        handler(`auditService.recordInTransaction({ userId: "u", action: "TRANSACTION_UPDATE", resourceType: "TRANSACTION" });`),
      );
      expect(a.problems).toHaveLength(1);
      expect(a.problems[0]).toMatch(/fx\/c\.ts:3: recordInTransaction is not directly inside/);
    });

    it("recordInTransaction in a nested callback inside a transaction is red", () => {
      const a = analyzeSource(
        "fx/d.ts",
        handler(
          `dbTransaction(() => { setTimeout(() => auditService.recordInTransaction({ userId: "u", action: "TRANSACTION_UPDATE", resourceType: "TRANSACTION" }), 0); });`,
        ),
      );
      expect(a.problems).toHaveLength(1);
      expect(a.problems[0]).toMatch(/recordInTransaction is not directly inside/);
    });

    it("an aliased import, optional chaining and element access are all seen", () => {
      const src =
        `import { auditService as audit } from "./auditService";\n` +
        `ipcMain.handle("things:do", async () => {\n` +
        `  await audit.log({ action: "LOGIN" });\n` +
        `  await audit?.log({ action: "LOGOUT" });\n` +
        `  await audit["log"]({ action: "DATA_ACCESS" });\n` +
        `});\n`;
      const a = analyzeSource("fx/e.ts", src);
      expect(a.problems).toEqual([]);
      expect(a.sites.map((s) => s.key)).toEqual([
        "fx/e.ts::things:do::LOGIN",
        "fx/e.ts::things:do::LOGOUT",
        "fx/e.ts::things:do::DATA_ACCESS",
      ]);
    });

    it("destructuring or copying the binding, and withAudit, are red", () => {
      const a = analyzeSource(
        "fx/f.ts",
        `${H}const { log } = auditService;\nconst a = auditService;\nfunction f() { return auditService.withAudit({}, async () => 1); }\n`,
      );
      expect(a.problems).toEqual([
        "fx/f.ts:2: auditService is copied or destructured; call it directly",
        "fx/f.ts:3: auditService is copied or destructured; call it directly",
        "fx/f.ts:4: withAudit was removed (BACKLOG-3339); use recordInTransaction + recordFailure",
      ]);
    });

    it("a site with no channel and no named function is red", () => {
      const a = analyzeSource("fx/g.ts", `${H}void (async () => { ${LOG} })();\n`);
      expect(a.problems).toEqual(["fx/g.ts:2: audit site resolves to no channel or named function"]);
    });
  });
});
