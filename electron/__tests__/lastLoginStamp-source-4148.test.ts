/**
 * @jest-environment node
 */
/*
 * BACKLOG-4148 — source pin: the browser sign-in stamps last_login_at in ONE
 * place, inside provisionDeepLinkLogin's transaction body, with the SYNC write.
 *
 * Why a source pin: no guard sees a promise-returning db call voided inside a
 * transaction body (`void updateLastLogin(...)` passes tsc, eslint, syncTwin,
 * writeAtomicity and the 3322 pin while committing over a failed UPDATE —
 * BACKLOG-3302 SR review, pm_comments b26c56b7 on BACKLOG-3302). And nothing
 * else would go red if a second stamp were added on one branch (main.ts or the
 * pending-user drain), stamping a sign-in twice.
 *
 * Behaviour controls: electron/services/__tests__/deepLinkLastLogin-4148.test.ts
 * (mocked db) and deepLinkProvisioningAtomicity-3322 D14-D16 (real driver).
 *
 * CRLF-normalised so a Windows checkout reads the same bodies (BACKLOG-3555).
 */
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const occurrences = (src: string, token: string): number => src.split(token).length - 1;

function body(rel: string, startMarker: string, endMarker: string): string {
  const src = read(rel);
  const a = src.indexOf(startMarker);
  expect([rel, startMarker, a >= 0]).toEqual([rel, startMarker, true]);
  const b = src.indexOf(endMarker, a + startMarker.length);
  expect([rel, endMarker, b > a]).toEqual([rel, endMarker, true]);
  return src.slice(a, b);
}

describe("BACKLOG-4148 last-login stamp placement", () => {
  it("provisionDeepLinkLogin's transaction body stamps once, with updateLastLoginSync, and re-reads the row", () => {
    const fn = body(
      "electron/services/loginProvisioningService.ts",
      "export function provisionDeepLinkLogin(",
      "\nexport ",
    );
    const tx = fn.slice(fn.indexOf("dbTransaction(() => {"));
    expect(fn.indexOf("dbTransaction(() => {")).toBeGreaterThanOrEqual(0);
    expect(occurrences(tx, "updateLastLoginSync(user.id)")).toBe(1);
    expect(occurrences(tx.replace(/updateLastLoginSync\(/g, ""), "updateLastLogin(")).toBe(0);
    expect(tx.indexOf("getUserByIdSync(user.id)")).toBeGreaterThan(tx.indexOf("updateLastLoginSync(user.id)"));
  });

  it("main.ts sends the provisioned row's dates to the renderer (buildDeepLinkAuthPayload gets localUser)", () => {
    const call = body("electron/main.ts", "buildDeepLinkAuthPayload({", "}),");
    expect(call).toMatch(/\n\s*localUser,/);
  });

  it.each([
    "electron/main.ts",
    "electron/handlers/systemHandlers.ts",
    "electron/services/signInState.ts",
  ])("%s stamps nothing itself", (rel) => {
    expect(occurrences(read(rel), "updateLastLogin")).toBe(0);
  });
});
