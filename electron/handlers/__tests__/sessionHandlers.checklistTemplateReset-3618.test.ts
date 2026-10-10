/**
 * BACKLOG-3618 C2 — every logout path drops the checklist template listing.
 *
 * A listing now holds the signed-in user's own checklists. The cache is keyed
 * on the user (proven in checklistTemplateService-3475.test.ts, "BACKLOG-3618
 * C2"); sign-out ALSO clears it, memory and file, through
 * `checklistTemplateService.invalidate()` (whose memory+file behaviour is
 * C13-H in that suite).
 */

const mockInvalidate = jest.fn();
jest.mock("../../services/checklistTemplateService", () => ({
  __esModule: true,
  default: { invalidate: (...a: unknown[]) => mockInvalidate(...a) },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as fs from "fs";
import * as path from "path";
import { resetChecklistTemplatesOnLogout } from "../sessionHandlers";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("resetChecklistTemplatesOnLogout (BACKLOG-3618)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("invalidates the template caches", async () => {
    resetChecklistTemplatesOnLogout();
    await flush();
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it("never throws into the logout path, even if invalidate() throws", async () => {
    mockInvalidate.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() => resetChecklistTemplatesOnLogout()).not.toThrow();
    await flush();
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it("is called by all three logout paths: logout, force logout, sign out of all devices", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sessionHandlers.ts"), "utf8");
    const bodyOf = (name: string): string => {
      const start = source.indexOf(`async function ${name}(`);
      if (start < 0) throw new Error(`${name} not found in sessionHandlers.ts`);
      const next = source.indexOf("\nasync function ", start + 1);
      return source.slice(start, next < 0 ? undefined : next);
    };
    // BACKLOG-3833: handleLogout goes through the shared signOutLocalSession
    // (also used by idle expiry), which must make the call itself.
    expect(bodyOf("handleLogout").includes("signOutLocalSession(")).toBe(true);
    const shared = fs.readFileSync(path.join(__dirname, "..", "sessionSignOut.ts"), "utf8");
    const sharedBody = shared.slice(shared.indexOf("export async function signOutLocalSession("));
    expect(sharedBody.includes("resetChecklistTemplatesOnLogout()")).toBe(true);
    for (const name of ["handleForceLogout", "handleSignOutAllDevices"]) {
      expect({ name, calls: bodyOf(name).includes("resetChecklistTemplatesOnLogout();") }).toEqual({
        name,
        calls: true,
      });
    }
  });
});
