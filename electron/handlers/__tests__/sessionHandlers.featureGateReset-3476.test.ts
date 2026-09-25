/**
 * BACKLOG-3476 — every logout path drops the feature-gate caches.
 *
 * The strict reader now remembers the signed-in user's membership. That answer
 * must not survive sign-out, so `resetFeatureGateOnLogout` calls
 * `featureGateService.invalidateCache()`, which drops both the plan map and the
 * cached membership (that half is proven in featureGateHandlers.orgCache-3476).
 */

const mockInvalidate = jest.fn();
jest.mock("../../services/featureGateService", () => ({
  __esModule: true,
  default: { invalidateCache: (...a: unknown[]) => mockInvalidate(...a) },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as fs from "fs";
import * as path from "path";
import { resetFeatureGateOnLogout } from "../sessionHandlers";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("resetFeatureGateOnLogout (BACKLOG-3476)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("invalidates the feature-gate caches", async () => {
    resetFeatureGateOnLogout();
    await flush();
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it("never throws into the logout path, even if invalidateCache() throws", async () => {
    mockInvalidate.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() => resetFeatureGateOnLogout()).not.toThrow();
    await flush();
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it("is called by all three logout paths: logout, force logout, sign out of all devices", () => {
    // The handlers need a database, a session file and Supabase to run end to
    // end; what matters here is that no path forgets the call. Each handler's
    // body is sliced out of the source and checked for it.
    const source = fs.readFileSync(path.join(__dirname, "..", "sessionHandlers.ts"), "utf8");
    const bodyOf = (name: string): string => {
      const start = source.indexOf(`async function ${name}(`);
      if (start < 0) throw new Error(`${name} not found in sessionHandlers.ts`);
      const next = source.indexOf("\nasync function ", start + 1);
      return source.slice(start, next < 0 ? undefined : next);
    };
    for (const name of ["handleLogout", "handleForceLogout", "handleSignOutAllDevices"]) {
      expect({ name, calls: bodyOf(name).includes("resetFeatureGateOnLogout();") }).toEqual({
        name,
        calls: true,
      });
    }
  });
});
