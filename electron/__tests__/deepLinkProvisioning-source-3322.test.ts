/**
 * @jest-environment node
 */
/*
 * BACKLOG-3322 — source pin: both deep-link sign-in branches provision through
 * the one transactional function and write no user or session row themselves.
 *
 * Why a source pin: `writeAtomicity.guard.test.ts` cannot see `electron/main.ts`,
 * so if `handleDeepLinkCallback` went back to inline `createUser` /
 * `createSession` calls nothing else would go red. For systemHandlers.ts the
 * write guard also reds (its KNOWN_UNWRAPPED entry is gone); this pin names the
 * exact call either way.
 *
 * The forced-crash proof that the function itself is atomic is
 * `electron/services/db/__tests__/deepLinkProvisioningAtomicity-3322.test.ts`.
 *
 * MUTATIONS THAT MAKE IT RED (run at adoption, BACKLOG-3322 PR 1)
 *   - main.ts restored to its pre-3322 inline writes            -> main.ts row
 *   - systemHandlers.ts restored to its pre-3322 inline writes  -> systemHandlers row, persist row
 *   - `persistSessionForUser` opens its own session row again   -> persist row
 *
 * CRLF-normalised so a Windows checkout reads the same bodies (BACKLOG-3555).
 */
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

/** The source between `startMarker` and the first `endMarker` after it; both must exist. */
function body(rel: string, startMarker: string, endMarker: string): string {
  const src = read(rel);
  const a = src.indexOf(startMarker);
  expect([rel, startMarker, a >= 0]).toEqual([rel, startMarker, true]);
  const b = src.indexOf(endMarker, a + startMarker.length);
  expect([rel, endMarker, b > a]).toEqual([rel, endMarker, true]);
  return src.slice(a, b);
}

const occurrences = (src: string, token: string): number => src.split(token).length - 1;

const INLINE_WRITES = [
  "databaseService.createUser(",
  "databaseService.createSession(",
  "syncDeepLinkUserToLocalDb(",
  "migrateUserIdForUnification(",
];

describe("BACKLOG-3322 deep-link sign-in provisions through provisionDeepLinkSignIn", () => {
  it.each([
    ["electron/main.ts", "async function handleDeepLinkCallback(", "\nfunction sendToRenderer("],
    [
      "electron/handlers/systemHandlers.ts",
      "const pendingUser = getAndClearPendingDeepLinkUser();",
      'initializationBroadcaster.broadcast({\n          stage: "creating-user"',
    ],
  ])("%s calls provisionDeepLinkSignIn once and writes no user/session row inline", (rel, start, end) => {
    const src = body(rel, start, end);
    expect(occurrences(src, "provisionDeepLinkSignIn(")).toBe(1);
    for (const w of INLINE_WRITES) {
      expect([w, occurrences(src, w)]).toEqual([w, 0]);
    }
  });

  it("persistSessionForUser writes no session row itself (the token comes from the provisioning transaction)", () => {
    const src = body("electron/handlers/systemHandlers.ts", "async function persistSessionForUser(", "\n}\n");
    expect(occurrences(src, "createSession(")).toBe(0);
    expect(src).toContain("sessionToken: string,");
  });
});
