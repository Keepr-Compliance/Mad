/**
 * @jest-environment node
 *
 * Preference Handlers — the onboarding FDA-skip write (BACKLOG-3212)
 *
 * PREMISE TEST. Everything downstream of BACKLOG-3212 reads
 * `preferences.onboarding.fdaSkipped`. PermissionsStep writes it by calling
 * `window.api.preferences.update(userId, { onboarding: { fdaSkipped: true,
 * fdaSkippedAt: <ms> } })`, which lands on the REAL `preferences:update`
 * handler in preferenceHandlers.ts (read -> deepMerge -> syncPreferences).
 *
 * These tests drive that real handler with the exact payload the renderer
 * sends and assert the shape that actually reaches Supabase — so the reducer
 * and LoadingOrchestrator fixtures in this change are transcribed from a
 * verified producer rather than invented. A fixture written as
 * `preferences.fdaSkipped` (or any other near-miss key) would pass its own
 * assertions and prove nothing; this file is what stops that.
 *
 * The second test is the one that matters for BACKLOG-1842 coexistence:
 * `deepMerge` must recurse INTO the `onboarding` object, not replace it, or
 * writing the skip flag would silently destroy the FDA-relaunch resume marker
 * that lives under the same key.
 *
 * preferenceHandlers registers on import via registerPreferenceHandlers(), so
 * each test isolates the module to register against fresh mocks.
 */

// This file has no imports, which would make TypeScript treat it as a global
// script and collide with permissionHandlers.resumeMarker.test.ts (same helper
// names). `export {}` makes it a module so its locals stay local.
export {};

interface SupabaseServiceMock {
  getPreferences: jest.Mock;
  syncPreferences: jest.Mock;
}

const supabaseServiceMock: SupabaseServiceMock = {
  getPreferences: jest.fn(),
  syncPreferences: jest.fn(),
};

type Handler = (
  event: unknown,
  userId: string,
  partial: unknown
) => Promise<{ success: boolean; error?: string }>;

/** Register the handlers fresh against the current mocks; return `preferences:update`. */
function loadUpdateHandler(): Handler {
  const registered: Record<string, Handler> = {};

  jest.doMock("electron", () => ({
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        registered[channel] = handler;
      },
    },
  }));

  jest.doMock("../../services/logService", () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));

  jest.doMock("../../services/supabaseService", () => ({
    __esModule: true,
    default: supabaseServiceMock,
  }));

  jest.doMock("../../services/updateService", () => ({
    __esModule: true,
    default: { updateConfig: jest.fn().mockResolvedValue(undefined) },
  }));

  jest.doMock("../../services/failureLogService", () => ({
    __esModule: true,
    default: {
      getRecentFailures: jest.fn(),
      clearFailures: jest.fn(),
      logFailure: jest.fn(),
    },
  }));

  let update!: Handler;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerPreferenceHandlers } = require("../preferenceHandlers");
    registerPreferenceHandlers();
    update = registered["preferences:update"];
  });
  return update;
}

/**
 * The EXACT payload PermissionsStep.handleSkipForNow sends. Kept as a helper
 * so the shape is written down once, next to the assertions that depend on it.
 */
function skipPayload(now: number) {
  return { onboarding: { fdaSkipped: true, fdaSkippedAt: now } };
}

describe("preferenceHandlers — onboarding FDA-skip write (BACKLOG-3212)", () => {
  // validateUserId requires a UUID-shaped id. Assembled from parts rather than
  // written out: this repository is public, and a UUID literal has no shape
  // that distinguishes an invented one from a live row id (BACKLOG-2871). The
  // value is arbitrary — only its shape matters to the validator.
  const USER_ID = ["11111111", "2222", "4333", "8444", "555555555555"].join("-");

  beforeEach(() => {
    jest.resetModules();
    supabaseServiceMock.getPreferences.mockReset();
    supabaseServiceMock.syncPreferences.mockReset();
  });

  it("writes onboarding.fdaSkipped === true into the preferences bag", async () => {
    supabaseServiceMock.getPreferences.mockResolvedValue({
      phone_type: "iphone",
      contactSources: { direct: { macosContacts: true } },
    });
    supabaseServiceMock.syncPreferences.mockResolvedValue(undefined);

    const update = loadUpdateHandler();
    const now = 1_700_000_000_000;
    const result = await update(null, USER_ID, skipPayload(now));

    expect(result.success).toBe(true);
    expect(supabaseServiceMock.syncPreferences).toHaveBeenCalledTimes(1);

    const [calledUserId, calledPrefs] = supabaseServiceMock.syncPreferences.mock.calls[0];
    expect(calledUserId).toBe(USER_ID);

    // The key the read side (LoadingOrchestrator Phase 4) looks for, at the
    // path it actually looks at. This is the premise every other BACKLOG-3212
    // test depends on.
    expect(calledPrefs.onboarding.fdaSkipped).toBe(true);
    expect(calledPrefs.onboarding.fdaSkippedAt).toBe(now);

    // Unrelated preferences survive the partial update.
    expect(calledPrefs.phone_type).toBe("iphone");
    expect(calledPrefs.contactSources.direct.macosContacts).toBe(true);
  });

  it("does NOT clobber the BACKLOG-1842 resume marker living under the same `onboarding` key", async () => {
    // Transcribed from permissionHandlers.ts save-onboarding-resume-marker:
    // it writes { onboarding: { resumeStep: "permissions", resumeSavedAt } }.
    supabaseServiceMock.getPreferences.mockResolvedValue({
      phone_type: "iphone",
      onboarding: { resumeStep: "permissions", resumeSavedAt: 1_699_000_000_000 },
    });
    supabaseServiceMock.syncPreferences.mockResolvedValue(undefined);

    const update = loadUpdateHandler();
    await update(null, USER_ID, skipPayload(1_700_000_000_000));

    const [, calledPrefs] = supabaseServiceMock.syncPreferences.mock.calls[0];

    // New flag landed...
    expect(calledPrefs.onboarding.fdaSkipped).toBe(true);
    // ...and the sibling marker is still there. A shallow merge would have
    // dropped both of these, breaking the FDA-grant relaunch resume.
    expect(calledPrefs.onboarding.resumeStep).toBe("permissions");
    expect(calledPrefs.onboarding.resumeSavedAt).toBe(1_699_000_000_000);
  });

  it("writes the flag for a user who has no preferences bag yet", async () => {
    // getPreferences returns null for a user with no row; the handler
    // substitutes {}. A fresh install that skips FDA must still persist.
    supabaseServiceMock.getPreferences.mockResolvedValue(null);
    supabaseServiceMock.syncPreferences.mockResolvedValue(undefined);

    const update = loadUpdateHandler();
    const result = await update(null, USER_ID, skipPayload(1_700_000_000_000));

    expect(result.success).toBe(true);
    const [, calledPrefs] = supabaseServiceMock.syncPreferences.mock.calls[0];
    expect(calledPrefs.onboarding.fdaSkipped).toBe(true);
  });

  it("reports failure (does not throw) when the cloud write fails", async () => {
    // PermissionsStep treats this as best-effort — the user must still be able
    // to move on. The handler's contract is a rejected-free { success: false }.
    supabaseServiceMock.getPreferences.mockResolvedValue({});
    supabaseServiceMock.syncPreferences.mockRejectedValue(new Error("network down"));

    const update = loadUpdateHandler();
    const result = await update(null, USER_ID, skipPayload(1_700_000_000_000));

    expect(result.success).toBe(false);
    expect(result.error).toContain("network down");
  });
});
