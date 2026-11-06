/**
 * @jest-environment node
 */

/**
 * BACKLOG-3302: the pending-login and pre-DB mailbox surface had no producer
 * and was deleted.
 *
 * PR 1 (main process, preload, IPC types, renderer service wrappers):
 *   `auth:complete-pending-login` and its handler, `provisionLogin`,
 *   `auth:{google,microsoft}:connect-mailbox-pending` and their popups,
 *   `auth:save-pending-mailbox-tokens`, the four `*:mailbox-pending-*` events,
 *   the popup-only `resolveCodeDirectly` / `rejectCodeDirectly`, and the
 *   matching bridge entries, typings and `authService` wrappers.
 * PR 2 (renderer state): `pendingOAuthData`, `PendingOAuthData`,
 *   `handleLoginPending`, `onLoginPending`, `onPendingOAuthClear`.
 *
 * Sign-in is the browser deep link (Login.tsx -> openAuthInBrowser ->
 * keepr:// -> handleDeepLinkCallback -> provisionDeepLinkSignIn); mailbox
 * connect is `auth:{google,microsoft}:connect-mailbox`.
 *
 * C1  none of the removed identifiers appears in production code under
 *     electron/ or src/, comments included (a stub that keeps the name is red).
 * C1p positive control: the scanner reads the files a stub would land in, and
 *     the live identifiers that sit next to the removed ones ARE found.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");

const REMOVED: ReadonlyArray<RegExp> = [
  // PR 1
  /auth:complete-pending-login/,
  /auth:(google|microsoft):connect-mailbox-pending/,
  /auth:save-pending-mailbox-tokens/,
  /(google|microsoft):mailbox-pending-(connected|cancelled)/,
  /\bhandleCompletePendingLogin\b/,
  /\bhandleSavePendingMailboxTokens\b/,
  /\bhandle(Google|Microsoft)ConnectMailboxPending\b/,
  /\bcompletePendingLogin\b/,
  /\b(google|microsoft)ConnectMailboxPending\b/,
  /\bsavePendingMailboxTokens\b/,
  /\bon(Google|Microsoft)MailboxPending(Connected|Cancelled)\b/,
  /\bprovisionLogin\b/,
  /\b(resolve|reject)CodeDirectly\b/,
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

describe("BACKLOG-3302: the pending-login and pre-DB mailbox surface is gone", () => {
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

  it("C1p the scanner sees the bridge, types, handlers, wrappers and the live neighbours", () => {
    for (const must of [
      "electron/preload/authBridge.ts",
      "electron/preload/eventBridge.ts",
      "electron/types/ipc/window-api-auth.ts",
      "electron/types/ipc/window-api-events.ts",
      "electron/handlers/sharedAuthHandlers.ts",
      "electron/handlers/googleAuthHandlers.ts",
      "electron/handlers/microsoftAuthHandlers.ts",
      "electron/services/loginProvisioningService.ts",
      "src/services/authService.ts",
      "src/components/Login.tsx",
    ])
      expect([must, files.includes(must)]).toEqual([must, true]);
    expect(read("electron/preload/authBridge.ts")).toMatch(/\bopenAuthInBrowser\b/);
    expect(read("src/components/Login.tsx")).toMatch(/\bopenAuthInBrowser\b/);
    expect(read("electron/main.ts")).toMatch(/\bprovisionDeepLinkSignIn\(/);
    expect(read("electron/services/loginProvisioningService.ts")).toMatch(/export function provisionDeepLinkLogin\(/);
    expect(read("electron/preload/authBridge.ts")).toMatch(/\bgoogleConnectMailbox\b/);
    expect(read("electron/handlers/googleAuthHandlers.ts")).toMatch(/"auth:google:connect-mailbox"/);
    expect(read("electron/handlers/microsoftAuthHandlers.ts")).toMatch(/"auth:microsoft:connect-mailbox"/);
  });
});
