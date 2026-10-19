/**
 * BACKLOG-3954 — every logout path ends the mailbox "can't reach" failure
 * streaks, so the next user on this profile starts from zero. (Pattern from
 * sessionHandlers.checklistTemplateReset-3618.test.ts.)
 */

const mockReset = jest.fn();
jest.mock("../../services/connectionStatusService", () => ({
  __esModule: true,
  default: { resetUnreachableStreaks: (...a: unknown[]) => mockReset(...a) },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as fs from "fs";
import * as path from "path";
import { resetMailboxReachabilityOnLogout } from "../sessionHandlers";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("resetMailboxReachabilityOnLogout (BACKLOG-3954)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ends the unreachable streaks", async () => {
    resetMailboxReachabilityOnLogout();
    await flush();
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it("never throws into the logout path, even if the reset throws", async () => {
    mockReset.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() => resetMailboxReachabilityOnLogout()).not.toThrow();
    await flush();
    expect(mockReset).toHaveBeenCalledTimes(1);
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
    expect(sharedBody.includes("resetMailboxReachabilityOnLogout()")).toBe(true);
    for (const name of ["handleForceLogout", "handleSignOutAllDevices"]) {
      expect({ name, calls: bodyOf(name).includes("resetMailboxReachabilityOnLogout();") }).toEqual({
        name,
        calls: true,
      });
    }
  });
});
