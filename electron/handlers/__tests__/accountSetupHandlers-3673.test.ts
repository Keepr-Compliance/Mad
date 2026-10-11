/**
 * BACKLOG-3673 C10 — the account-setup handlers read and write ONE record,
 * `users.onboarding_completed_at`, for the SESSION user only.
 *
 * Fixtures: `getAccountSetupRecord` returns the projection of the two `users`
 * columns it selects; `getPreferences` returns the `user_preferences.preferences`
 * bag, with `contactSources.direct` in the shape ContactSourceStep writes.
 * No real values.
 */

const registered: Record<string, (...args: unknown[]) => unknown> = {};
jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      registered[channel] = fn;
    },
  },
}));

const mockGetAuthUserId = jest.fn();
const mockGetAccountSetupRecord = jest.fn();
const mockGetPreferences = jest.fn();
const mockCompleteAccountSetup = jest.fn();
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getAuthUserId: () => mockGetAuthUserId(),
    getAccountSetupRecord: (...a: unknown[]) => mockGetAccountSetupRecord(...a),
    getPreferences: (...a: unknown[]) => mockGetPreferences(...a),
    completeAccountSetup: (...a: unknown[]) => mockCompleteAccountSetup(...a),
  },
}));

const mockLoadSession = jest.fn();
const mockUpdateSession = jest.fn();
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: {
    loadSession: () => mockLoadSession(),
    updateSession: (...a: unknown[]) => mockUpdateSession(...a),
  },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCaptureException = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
}));

import {
  ACCOUNT_SETUP_READ_TIMEOUT_MS,
  registerAccountSetupHandlers,
} from "../accountSetupHandlers";

const SESSION_USER = "session-user-id";
const OTHER_USER = "renderer-supplied-id";
const TS = "2026-09-30T12:00:00.000Z";

registerAccountSetupHandlers();
const getSetup = (...args: unknown[]) =>
  registered["user:get-account-setup"]({} as never, ...args) as Promise<{
    success: boolean;
    setup: string;
    emailStepAnswered: boolean;
    contactSourceAnswered: boolean;
  }>;
const completeSetup = (...args: unknown[]) =>
  registered["user:complete-account-setup"]({} as never, ...args) as Promise<{
    success: boolean;
    error?: string;
  }>;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthUserId.mockReturnValue(SESSION_USER);
  mockGetPreferences.mockResolvedValue({});
  mockLoadSession.mockResolvedValue({ user: { id: SESSION_USER } });
  mockUpdateSession.mockResolvedValue(true);
});

describe("C10 — user:get-account-setup", () => {
  it("registers both channels", () => {
    expect(typeof registered["user:get-account-setup"]).toBe("function");
    expect(typeof registered["user:complete-account-setup"]).toBe("function");
  });

  it("reads the SESSION user; a renderer-supplied id is ignored", async () => {
    mockGetAccountSetupRecord.mockResolvedValue({
      found: true,
      onboardingCompletedAt: null,
      emailOnboardingCompletedAt: null,
    });
    await getSetup(OTHER_USER);
    expect(mockGetAccountSetupRecord).toHaveBeenCalledWith(SESSION_USER);
    expect(mockGetAccountSetupRecord).not.toHaveBeenCalledWith(OTHER_USER);
    expect(mockGetPreferences).toHaveBeenCalledWith(SESSION_USER);
  });

  it("{null, null} -> not-finished, nothing answered", async () => {
    mockGetAccountSetupRecord.mockResolvedValue({
      found: true,
      onboardingCompletedAt: null,
      emailOnboardingCompletedAt: null,
    });
    await expect(getSetup()).resolves.toEqual({
      success: true,
      setup: "not-finished",
      emailStepAnswered: false,
      contactSourceAnswered: false,
      emailProviders: [],
    });
  });

  it("{ts, *} -> finished, and the cache is written", async () => {
    mockGetAccountSetupRecord.mockResolvedValue({
      found: true,
      onboardingCompletedAt: TS,
      emailOnboardingCompletedAt: TS,
    });
    mockGetPreferences.mockResolvedValue({
      contactSources: { direct: { outlookContacts: true, macosContacts: false } },
    });
    await expect(getSetup()).resolves.toEqual({
      success: true,
      setup: "finished",
      emailStepAnswered: true,
      contactSourceAnswered: true,
      emailProviders: [],
    });
    expect(mockUpdateSession).toHaveBeenCalledWith({ accountSetupFinishedAt: TS });
  });

  it("the email-step answer alone is NOT finished (the record decides)", async () => {
    mockGetAccountSetupRecord.mockResolvedValue({
      found: true,
      onboardingCompletedAt: null,
      emailOnboardingCompletedAt: TS,
    });
    const r = await getSetup();
    expect(r.setup).toBe("not-finished");
    expect(r.emailStepAnswered).toBe(true);
    // A stale cache is cleared when the server says not finished.
    expect(mockUpdateSession).toHaveBeenCalledWith({ accountSetupFinishedAt: undefined });
  });

  it("no row and no error -> not-finished (SR condition 4)", async () => {
    mockGetAccountSetupRecord.mockResolvedValue({
      found: false,
      onboardingCompletedAt: null,
      emailOnboardingCompletedAt: null,
    });
    expect((await getSetup()).setup).toBe("not-finished");
  });

  it("the server beats the cache: server empty + cache finished -> not-finished, cache cleared", async () => {
    mockGetAccountSetupRecord.mockResolvedValue({
      found: true,
      onboardingCompletedAt: null,
      emailOnboardingCompletedAt: null,
    });
    mockLoadSession.mockResolvedValue({ user: { id: SESSION_USER }, accountSetupFinishedAt: TS });
    const r = await getSetup();
    expect(r.setup).toBe("not-finished");
    expect(mockUpdateSession).toHaveBeenCalledWith({ accountSetupFinishedAt: undefined });
    expect(mockUpdateSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ accountSetupFinishedAt: expect.any(String) }),
    );
  });

  it("server throws, cache says finished -> finished", async () => {
    mockGetAccountSetupRecord.mockRejectedValue(new Error("network down"));
    mockLoadSession.mockResolvedValue({ user: { id: SESSION_USER }, accountSetupFinishedAt: TS });
    const r = await getSetup();
    expect(r).toEqual({
      success: true,
      setup: "finished",
      emailStepAnswered: false,
      contactSourceAnswered: false,
    });
  });

  it("server throws, no cache -> unknown (never finished: fail closed)", async () => {
    mockGetAccountSetupRecord.mockRejectedValue(new Error("network down"));
    mockLoadSession.mockResolvedValue({ user: { id: SESSION_USER } });
    expect((await getSetup()).setup).toBe("unknown");
  });

  it("server hangs past the bound -> answers from the cache, not forever", async () => {
    jest.useFakeTimers();
    try {
      mockGetAccountSetupRecord.mockReturnValue(new Promise(() => {}));
      mockLoadSession.mockResolvedValue({ user: { id: SESSION_USER } });
      const pending = getSetup();
      await jest.advanceTimersByTimeAsync(ACCOUNT_SETUP_READ_TIMEOUT_MS + 1);
      expect((await pending).setup).toBe("unknown");
    } finally {
      jest.useRealTimers();
    }
  });

  it("no session user -> the cache if finished, else unknown; the server is not asked", async () => {
    mockGetAuthUserId.mockReturnValue(null);
    mockLoadSession.mockResolvedValue(null);
    expect((await getSetup()).setup).toBe("unknown");
    mockLoadSession.mockResolvedValue({ user: { id: SESSION_USER }, accountSetupFinishedAt: TS });
    expect((await getSetup()).setup).toBe("finished");
    expect(mockGetAccountSetupRecord).not.toHaveBeenCalled();
  });

  it("no session user is logged and tagged apart from a failed server read (SR C4)", async () => {
    const logService = jest.requireMock("../../services/logService").default as { warn: jest.Mock };
    const tagsOf = () =>
      mockCaptureException.mock.calls.map(
        (c) => (c[1] as { tags?: Record<string, string> } | undefined)?.tags ?? {},
      );

    mockGetAuthUserId.mockReturnValue(null);
    mockLoadSession.mockResolvedValue(null);
    expect((await getSetup()).setup).toBe("unknown");
    expect(tagsOf()).toEqual([
      { service: "account-setup", operation: "getAccountSetup", account_setup_reason: "no-session-user" },
    ]);
    expect(logService.warn.mock.calls.map((c) => c[0])).toEqual([
      "[AccountSetup] No session user; answering from cache",
    ]);

    // A failed server read for a session user does NOT carry that tag.
    jest.clearAllMocks();
    mockGetAuthUserId.mockReturnValue(SESSION_USER);
    mockGetPreferences.mockResolvedValue({});
    mockGetAccountSetupRecord.mockRejectedValue(new Error("network down"));
    mockLoadSession.mockResolvedValue(null);
    expect((await getSetup()).setup).toBe("unknown");
    expect(tagsOf().some((t) => t.account_setup_reason === "no-session-user")).toBe(false);
    expect(logService.warn.mock.calls.map((c) => c[0])).toEqual([
      "[AccountSetup] Server read failed; answering from cache",
    ]);
  });
});

describe("C10 — user:complete-account-setup", () => {
  it("writes for the SESSION user only; a renderer-supplied id is ignored", async () => {
    mockCompleteAccountSetup.mockResolvedValue(undefined);
    await expect(completeSetup(OTHER_USER)).resolves.toEqual({ success: true });
    expect(mockCompleteAccountSetup).toHaveBeenCalledTimes(1);
    expect(mockCompleteAccountSetup).toHaveBeenCalledWith(SESSION_USER);
    expect(mockUpdateSession).toHaveBeenCalledWith(
      expect.objectContaining({ accountSetupFinishedAt: expect.any(String) }),
    );
  });

  it("a failed write is reported as a failure (never success) and sent to Sentry", async () => {
    mockCompleteAccountSetup.mockRejectedValue(new Error("rls denied"));
    const r = await completeSetup();
    expect(r.success).toBe(false);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockUpdateSession).not.toHaveBeenCalled();
  });

  it("no session user -> no write, failure", async () => {
    mockGetAuthUserId.mockReturnValue(null);
    const r = await completeSetup();
    expect(r.success).toBe(false);
    expect(mockCompleteAccountSetup).not.toHaveBeenCalled();
  });
});

// =============================================================================
// BACKLOG-3888: the recorded mailbox providers ride the same bounded read
// =============================================================================
describe("BACKLOG-3888 — emailProviders from the account-setup read", () => {
  beforeEach(() => {
    mockGetAccountSetupRecord.mockResolvedValue({
      found: true,
      onboardingCompletedAt: TS,
      emailOnboardingCompletedAt: TS,
    });
  });

  it("returns the recorded set from preferences.emailProviders", async () => {
    mockGetPreferences.mockResolvedValue({ emailProviders: ["outlook", "gmail"], phone_type: "iphone" });
    const r = (await getSetup()) as { emailProviders?: string[] };
    expect(r.emailProviders).toEqual(["outlook", "gmail"]);
  });

  it("drops malformed entries; a non-array is an empty set", async () => {
    mockGetPreferences.mockResolvedValue({ emailProviders: ["outlook", 7, ""] });
    expect(((await getSetup()) as { emailProviders?: string[] }).emailProviders).toEqual(["outlook"]);
    mockGetPreferences.mockResolvedValue({ emailProviders: "outlook" });
    expect(((await getSetup()) as { emailProviders?: string[] }).emailProviders).toEqual([]);
  });

  it("a hung preferences read does not hold startup past the existing bound", async () => {
    jest.useFakeTimers();
    try {
      mockGetPreferences.mockReturnValue(new Promise(() => {}));
      mockLoadSession.mockResolvedValue({ user: { id: SESSION_USER }, accountSetupFinishedAt: TS });
      let settled = false;
      const pending = getSetup().then((r) => {
        settled = true;
        return r;
      });
      await jest.advanceTimersByTimeAsync(ACCOUNT_SETUP_READ_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
      const r = (await pending) as { setup: string; emailProviders?: string[] };
      expect(r.setup).toBe("finished");
      expect(r.emailProviders).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
