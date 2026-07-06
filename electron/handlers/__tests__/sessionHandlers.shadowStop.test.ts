/**
 * BACKLOG-1840: every logout path (handleLogout / handleForceLogout /
 * handleSignOutAllDevices) must stop the shadow delta poller so it can't keep
 * ticking with a stale user id after sign-out. All three call the shared
 * stopShadowDeltaSyncOnLogout() wrapper, exercised here.
 */

const mockStop = jest.fn();
jest.mock("../../services/shadowDeltaSyncService", () => ({
  __esModule: true,
  default: { stop: (...a: unknown[]) => mockStop(...a) },
}));

// logService is used by the wrapper's fail-closed catch.
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { stopShadowDeltaSyncOnLogout } from "../sessionHandlers";

/** Let the wrapper's dynamic import + .then() settle (macrotask, jsdom-safe). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("stopShadowDeltaSyncOnLogout (BACKLOG-1840)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("stops the shadow delta poller (the teardown shared by all logout paths)", async () => {
    stopShadowDeltaSyncOnLogout();
    await flush();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("never throws into the logout path, even if stop() throws", async () => {
    mockStop.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() => stopShadowDeltaSyncOnLogout()).not.toThrow();
    await flush(); // rejection is swallowed by the wrapper's .catch — no unhandled rejection
    expect(mockStop).toHaveBeenCalledTimes(1);
  });
});
