/**
 * @jest-environment node
 */
/*
 * BACKLOG-3340 — source pin for the two sign-in denials main.ts records.
 *
 * main.ts has no unit harness (it is only ever mocked), so if either call below
 * were dropped every behavioural control would stay green. The LOGIN entry and
 * the provisioning-failure entry are NOT pinned here: they live in
 * loginProvisioningService.ts and are driven by deepLinkSignInAudit-3340 and the
 * real-driver deepLinkProvisioningAtomicity-3322.
 *
 * Also pins that handleDeepLinkCallback writes no audit entry directly: every
 * sign-in entry goes through loginProvisioningService (one LOGIN site).
 *
 * And pins how many times each file calls recordDeepLinkSignInFailure: one
 * failed sign-in writes at most one LOGIN_FAILED, from one site per reason. A
 * second call in a caller's catch (main.ts's provisioning catch, the drain's
 * catch in systemHandlers.ts) or from the session-file retries (signInState.ts)
 * would write a second row, or a LOGIN_FAILED after a committed LOGIN.
 *
 * CRLF-normalised so a Windows checkout reads the same body (BACKLOG-3555).
 */
import { readFileSync } from "fs";
import path from "path";
import ts from "typescript";

const ROOT = path.join(__dirname, "..", "..");

function body(rel: string, startMarker: string, endMarker: string): string {
  const src = readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  const a = src.indexOf(startMarker);
  expect([rel, startMarker, a >= 0]).toEqual([rel, startMarker, true]);
  const b = src.indexOf(endMarker, a + startMarker.length);
  expect([rel, endMarker, b > a]).toEqual([rel, endMarker, true]);
  return src.slice(a, b);
}

const occurrences = (src: string, token: string): number => src.split(token).length - 1;

describe("BACKLOG-3340 handleDeepLinkCallback records its two sign-in denials", () => {
  const src = body("electron/main.ts", "async function handleDeepLinkCallback(", "\nfunction sendToRenderer(");

  it.each([
    ["license_blocked", '"auth:deep-link-license-blocked"'],
    ["device_limit", '"auth:deep-link-device-limit"'],
  ])("records %s once, before the renderer is told", (reason, rendererEvent) => {
    const call = `recordDeepLinkSignInFailure(signInIdentity, "${reason}");`;
    expect([reason, occurrences(src, call)]).toEqual([reason, 1]);
    expect(src.indexOf(call)).toBeLessThan(src.indexOf(rendererEvent));
  });

  it("writes no audit entry itself", () => {
    expect(occurrences(src, "auditService.")).toBe(0);
  });
});

/**
 * Calls to and declarations of `name` in a file, counted on the TypeScript AST
 * (comments and strings cannot match). A call is any call expression whose
 * callee is `name` or `<anything>.name`.
 */
function countCalls(rel: string, name: string): { calls: number; defs: number } {
  const text = readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let calls = 0;
  let defs = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (
        (ts.isIdentifier(callee) && callee.text === name) ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === name)
      ) {
        calls++;
      }
    }
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) defs++;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { calls, defs };
}

describe("BACKLOG-3340 LOGIN_FAILED call count per file", () => {
  it.each([
    // [file, calls, declarations]
    ["electron/main.ts", 2, 0],
    ["electron/handlers/systemHandlers.ts", 1, 0],
    ["electron/services/loginProvisioningService.ts", 1, 1],
    ["electron/services/signInState.ts", 0, 0],
  ])("%s calls recordDeepLinkSignInFailure %i time(s) and declares it %i time(s)", (rel, calls, defs) => {
    const got = countCalls(rel, "recordDeepLinkSignInFailure");
    expect([rel, got.calls, got.defs]).toEqual([rel, calls, defs]);
  });
});
