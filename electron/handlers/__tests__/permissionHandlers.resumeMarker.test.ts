/**
 * @jest-environment node
 *
 * Permission Handlers — onboarding resume marker (BACKLOG-1842 resume-at-step
 * fix round)
 *
 * Founder QA found that after the FDA-grant relaunch, onboarding restarted
 * from phone-type instead of resuming at permissions. The fix persists a
 * single-use resume marker to Supabase (user_preferences.preferences.onboarding
 * .resumeStep) right before the relaunch fires, cloud-backed to match
 * phoneType (setPhoneTypeCloud) and contactSources (ContactSourceStep), which
 * already live in the same preferences bag and are already readable before
 * local DB init.
 *
 * These tests pin:
 *   - save-onboarding-resume-marker writes resumeStep: "permissions" into the
 *     existing preferences bag (merge, not overwrite)
 *   - consume-onboarding-resume-marker reads it back and clears it (single-use)
 *   - a normal launch (no marker ever saved) returns resumeStep: null
 *   - a write/read failure degrades gracefully (never throws to the caller)
 *
 * permissionHandlers uses a module-level `handlersRegistered` guard, so each
 * test isolates the module to re-register against a fresh mock.
 */

interface SupabaseServiceMock {
  getPreferences: jest.Mock;
  syncPreferences: jest.Mock;
}

const supabaseServiceMock: SupabaseServiceMock = {
  getPreferences: jest.fn(),
  syncPreferences: jest.fn(),
};

type Handler = (event: unknown, payload: { userId: string }) => Promise<unknown>;

/**
 * Register the handlers fresh against the current mocks and return the
 * captured save/consume handlers.
 */
function loadMarkerHandlers(): {
  save: Handler;
  consume: Handler;
} {
  const registered: Record<string, Handler> = {};

  jest.doMock("electron", () => ({
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        registered[channel] = handler;
      },
    },
    app: {
      isPackaged: true,
      relaunch: jest.fn(),
      exit: jest.fn(),
      getPath: jest.fn(() => "/Applications/Keepr.app/Contents/MacOS/Keepr"),
      getName: jest.fn(() => "Keepr"),
    },
    shell: { openExternal: jest.fn() },
  }));

  jest.doMock("../../services/logService", () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));

  jest.doMock("../../services/supabaseService", () => ({
    __esModule: true,
    default: supabaseServiceMock,
  }));

  let save!: Handler;
  let consume!: Handler;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerPermissionHandlers } = require("../permissionHandlers");
    registerPermissionHandlers();
    save = registered["save-onboarding-resume-marker"];
    consume = registered["consume-onboarding-resume-marker"];
  });
  return { save, consume };
}

describe("permissionHandlers — onboarding resume marker (BACKLOG-1842)", () => {
  const USER_ID = "user-123";

  beforeEach(() => {
    jest.resetModules();
    supabaseServiceMock.getPreferences.mockReset();
    supabaseServiceMock.syncPreferences.mockReset();
  });

  it("registers both handlers", () => {
    const { save, consume } = loadMarkerHandlers();
    expect(typeof save).toBe("function");
    expect(typeof consume).toBe("function");
  });

  it("save merges resumeStep into the EXISTING preferences bag (does not clobber other fields)", async () => {
    supabaseServiceMock.getPreferences.mockResolvedValue({
      phone_type: "iphone",
      contactSources: { direct: { macosContacts: true } },
    });
    supabaseServiceMock.syncPreferences.mockResolvedValue(undefined);

    const { save } = loadMarkerHandlers();
    const result = await save(null, { userId: USER_ID });

    expect(result).toEqual({ success: true });
    expect(supabaseServiceMock.syncPreferences).toHaveBeenCalledTimes(1);
    const [calledUserId, calledPrefs] = supabaseServiceMock.syncPreferences.mock.calls[0];
    expect(calledUserId).toBe(USER_ID);
    // Existing data preserved
    expect(calledPrefs.phone_type).toBe("iphone");
    expect(calledPrefs.contactSources.direct.macosContacts).toBe(true);
    // New marker written
    expect(calledPrefs.onboarding.resumeStep).toBe("permissions");
    expect(typeof calledPrefs.onboarding.resumeSavedAt).toBe("number");
  });

  it("consume reads resumeStep back and clears it (single-use)", async () => {
    supabaseServiceMock.getPreferences.mockResolvedValue({
      phone_type: "iphone",
      onboarding: { resumeStep: "permissions", resumeSavedAt: Date.now() },
    });
    supabaseServiceMock.syncPreferences.mockResolvedValue(undefined);

    const { consume } = loadMarkerHandlers();
    const result = await consume(null, { userId: USER_ID });

    expect(result).toEqual({ resumeStep: "permissions" });
    // Clearing write happened (best-effort, but must be attempted)
    expect(supabaseServiceMock.syncPreferences).toHaveBeenCalledTimes(1);
    const [, calledPrefs] = supabaseServiceMock.syncPreferences.mock.calls[0];
    expect(calledPrefs.onboarding.resumeStep).toBeNull();
  });

  it("a normal launch with no marker ever saved returns resumeStep: null and does NOT write", async () => {
    supabaseServiceMock.getPreferences.mockResolvedValue({
      phone_type: "iphone",
      // no `onboarding` key at all — matches a user who has never gone
      // through the FDA relaunch path
    });

    const { consume } = loadMarkerHandlers();
    const result = await consume(null, { userId: USER_ID });

    expect(result).toEqual({ resumeStep: null });
    expect(supabaseServiceMock.syncPreferences).not.toHaveBeenCalled();
  });

  it("consuming twice in a row only resumes once (single-use, not hijacking a later launch)", async () => {
    // First consume: marker present.
    supabaseServiceMock.getPreferences.mockResolvedValueOnce({
      onboarding: { resumeStep: "permissions", resumeSavedAt: Date.now() },
    });
    supabaseServiceMock.syncPreferences.mockResolvedValue(undefined);

    const { consume } = loadMarkerHandlers();
    const first = await consume(null, { userId: USER_ID });
    expect(first).toEqual({ resumeStep: "permissions" });

    // Second consume (e.g. a later, unrelated launch): the clearing write
    // from the first call is what a real Supabase round-trip would reflect —
    // simulate that by returning the cleared state.
    supabaseServiceMock.getPreferences.mockResolvedValueOnce({
      onboarding: { resumeStep: null, resumeSavedAt: expect.any(Number) },
    });
    const second = await consume(null, { userId: USER_ID });
    expect(second).toEqual({ resumeStep: null });
  });

  it("save degrades gracefully on a Supabase write failure (never throws)", async () => {
    supabaseServiceMock.getPreferences.mockResolvedValue({});
    supabaseServiceMock.syncPreferences.mockRejectedValue(new Error("network down"));

    const { save } = loadMarkerHandlers();
    const result = await save(null, { userId: USER_ID });

    expect((result as { success: boolean }).success).toBe(false);
  });

  it("consume degrades gracefully on a Supabase read failure (returns null, never throws)", async () => {
    supabaseServiceMock.getPreferences.mockRejectedValue(new Error("network down"));

    const { consume } = loadMarkerHandlers();
    const result = await consume(null, { userId: USER_ID });

    expect(result).toEqual({ resumeStep: null });
  });
});
