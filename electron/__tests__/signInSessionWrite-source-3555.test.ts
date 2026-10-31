/**
 * @jest-environment node
 */

/**
 * BACKLOG-3555: a sign-in writes session.json only through saveSignInSession,
 * which is what clears the "session not written yet" flag in signInState.ts.
 *
 * main.ts has no unit harness (it is only ever mocked), so a call site that
 * went back to the plain sessionService.saveSession would leave the flag set
 * with every behavioural control still green. This reads the two sign-in
 * write sites from source and fails if either does.
 */
import { readFileSync } from "fs";
import path from "path";

/** The body of a top-level function: from its declaration to the first line that is exactly "}". */
function functionBody(file: string, declaration: string): string {
  // Windows checkouts use CRLF; the function-end search below is LF-only.
  const text = readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf(declaration);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("BACKLOG-3555: sign-in session writes go through saveSignInSession", () => {
  it.each([
    ["main.ts", "async function handleDeepLinkCallback("],
    ["handlers/systemHandlers.ts", "async function persistSessionForUser("],
  ])("%s %s writes the session with saveSignInSession, never sessionService.saveSession", (file, declaration) => {
    const body = functionBody(file, declaration);
    expect(count(body, "saveSignInSession(")).toBeGreaterThanOrEqual(1);
    expect(count(body, "sessionService.saveSession(")).toBe(0);
    if (file === "main.ts") expect(count(body, "noteSignIn(")).toBeGreaterThanOrEqual(1);
  });
});
