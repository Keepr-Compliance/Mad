/**
 * @jest-environment node
 */

/**
 * BACKLOG-4103: the in-app OAuth-window sign-in (Google/Microsoft login +
 * complete-login handlers, their preload bridge entries, IPC types, renderer
 * wrappers and login-* events) had no caller in src/ and was deleted. Sign-in
 * is the browser deep link (Login.tsx -> openAuthInBrowser -> keepr://).
 *
 * C1  none of the removed identifiers appears in production code under
 *     electron/ or src/ (a stub that keeps the name is red too).
 * C1p positive control: the scanner reads the files a stub would land in, and
 *     a live identifier (openAuthInBrowser) IS found in both halves.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");

const REMOVED: ReadonlyArray<RegExp> = [
  /auth:google:login\b/,
  /auth:google:complete-login/,
  /auth:microsoft:login\b/,
  /auth:microsoft:complete-login/,
  /(google|microsoft):login-(complete|pending|cancelled)/,
  /\bhandleGoogleLogin\b/,
  /\bhandleGoogleCompleteLogin\b/,
  /\bhandleMicrosoftLogin\b/,
  /\bgoogleLogin\b/,
  /\bmicrosoftLogin\b/,
  /\bgoogleCompleteLogin\b/,
  /\bmicrosoftCompleteLogin\b/,
  /\bon(Google|Microsoft)Login(Complete|Pending|Cancelled)\b/,
  /\bauthenticateForLogin\b/,
];

function productionFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--", "electron", "src"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .filter(
      (f) =>
        /\.(ts|tsx|js|jsx)$/.test(f) &&
        !/(__tests__|__mocks__|\.test\.|\.spec\.)/.test(f),
    );
}

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

describe("BACKLOG-4103: the in-app OAuth login path is gone", () => {
  const files = productionFiles();

  it("C1 no removed identifier appears in production code", () => {
    const hits: string[] = [];
    for (const rel of files) {
      const lines = read(rel).split("\n");
      lines.forEach((l, i) => {
        for (const re of REMOVED) if (re.test(l)) hits.push(`${rel}:${i + 1} ${re}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("C1p the scanner sees the bridge, types, wrapper and a live identifier", () => {
    for (const must of [
      "electron/preload/authBridge.ts",
      "electron/preload/eventBridge.ts",
      "electron/types/ipc/window-api-auth.ts",
      "electron/types/ipc/window-api-events.ts",
      "electron/handlers/googleAuthHandlers.ts",
      "electron/handlers/microsoftAuthHandlers.ts",
      "src/services/authService.ts",
      "src/components/Login.tsx",
    ])
      expect([must, files.includes(must)]).toEqual([must, true]);
    expect(read("electron/preload/authBridge.ts")).toMatch(/\bopenAuthInBrowser\b/);
    expect(read("src/components/Login.tsx")).toMatch(/\bopenAuthInBrowser\b/);
  });
});
