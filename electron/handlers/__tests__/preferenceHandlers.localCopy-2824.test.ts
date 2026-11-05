/**
 * @jest-environment node
 */

/**
 * BACKLOG-2824: `preferences:get` serves the local copy of the preferences bag
 * when, and only when, the cloud read fails. Real handler + real
 * preferencesMirror; the cloud (supabaseService) and the session file are
 * stand-ins.
 *
 * C1  no copy + cloud fails        -> { success: false } as before (the 2890/2893 holds react to it)
 * C2  copy + cloud fails           -> the copy, source "copy"
 * C3  copy + cloud succeeds        -> the CLOUD bag, source "cloud" (never the copy)
 * C4  another user's copy          -> no copy -> failure
 * C9b preferences:update offline   -> fails, nothing written, the copy is never merged into
 * C10 invalid user id              -> validation failure, the copy is not looked at
 */

import type { IpcMainInvokeEvent } from "electron";
import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
  type RegisteredIpcHandler,
} from "../../../tests/support/ipcHandlerRegistry";

type Session = Record<string, unknown>;

let mockStored: Session | null = null;
const mockLoadSession = jest.fn(async () => mockStored);

jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: {
    loadSession: () => mockLoadSession(),
    updateSession: jest.fn(async () => true),
    getGeneration: () => 1,
  },
}));

const mockIpcHandle = jest.fn();
jest.mock("electron", () => ({ ipcMain: { handle: mockIpcHandle } }));

jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: jest.fn(), syncPreferences: jest.fn() },
}));

import { registerPreferenceHandlers } from "../preferenceHandlers";
import supabaseService from "../../services/supabaseService";

const cloud = supabaseService as jest.Mocked<typeof supabaseService>;

// pii-allow-uuid: invented, not from any live row
const USER = "00000000-0000-4000-8000-000000000001";
// pii-allow-uuid: invented, not from any live row
const OTHER_USER = "00000000-0000-4000-8000-000000000002";

const COPY_A = {
  userId: USER,
  preferences: { messages: { source: "android-companion" }, phone_type: "android" },
  copiedAt: "2026-11-01T10:00:00.000Z",
};

describe("BACKLOG-2824 preferences:get and the local preferences copy", () => {
  let handlers: IpcHandlerRegistry;
  const event = {} as IpcMainInvokeEvent;
  const get = (userId: string) => handlers.get("preferences:get")(event, userId);

  beforeAll(() => {
    handlers = createIpcHandlerRegistry();
    mockIpcHandle.mockImplementation((channel: string, handler: RegisteredIpcHandler) => {
      handlers.set(channel, handler);
    });
    registerPreferenceHandlers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockStored = { user: { id: USER } };
  });

  it("C1: no copy and the cloud read fails -> the failure, as before", async () => {
    cloud.getPreferences.mockRejectedValue(new Error("TypeError: fetch failed"));

    const result = await get(USER);

    expect(result).toEqual({ success: false, error: "TypeError: fetch failed" });
  });

  it("C2: a copy and the cloud read fails -> the copy, marked as the copy", async () => {
    mockStored = { user: { id: USER }, preferencesCopy: COPY_A };
    cloud.getPreferences.mockRejectedValue(new Error("TypeError: fetch failed"));

    const result = await get(USER);

    // This exact object is the fixture the BACKLOG-2890 hook test uses
    // (src/hooks/__tests__/useAutoRefresh.test.ts, "returning user offline").
    expect(result).toEqual({
      success: true,
      preferences: COPY_A.preferences,
      source: "copy",
      copiedAt: COPY_A.copiedAt,
    });
  });

  it("C3: a copy and the cloud read succeeds -> the cloud bag, never the copy", async () => {
    mockStored = { user: { id: USER }, preferencesCopy: COPY_A };
    const cloudBag = { messages: { source: "iphone-sync" }, phone_type: "iphone" };
    cloud.getPreferences.mockResolvedValue(cloudBag);

    const result = await get(USER);

    expect(result).toEqual({ success: true, preferences: cloudBag, source: "cloud" });
  });

  it("C3: a copy and the cloud says nothing is saved ({}) -> {}, never the copy", async () => {
    mockStored = { user: { id: USER }, preferencesCopy: COPY_A };
    cloud.getPreferences.mockResolvedValue({});

    const result = await get(USER);

    expect(result).toEqual({ success: true, preferences: {}, source: "cloud" });
  });

  it("C4: a copy for another user is no copy -> the failure", async () => {
    mockStored = { user: { id: USER }, preferencesCopy: { ...COPY_A, userId: OTHER_USER } };
    cloud.getPreferences.mockRejectedValue(new Error("TypeError: fetch failed"));

    const result = await get(USER);

    expect(result).toEqual({ success: false, error: "TypeError: fetch failed" });
  });

  it("C4: a copy that does not parse is no copy -> the failure", async () => {
    mockStored = { user: { id: USER }, preferencesCopy: { userId: USER, preferences: "corrupt" } };
    cloud.getPreferences.mockRejectedValue(new Error("TypeError: fetch failed"));

    const result = await get(USER);

    expect(result).toEqual({ success: false, error: "TypeError: fetch failed" });
  });

  it("C9b: preferences:update offline fails and never merges into the copy", async () => {
    mockStored = { user: { id: USER }, preferencesCopy: COPY_A };
    cloud.getPreferences.mockRejectedValue(new Error("TypeError: fetch failed"));

    const result = await handlers.get("preferences:update")(event, USER, {
      messages: { source: "macos-native" },
    });

    expect(result).toEqual({ success: false, error: "TypeError: fetch failed" });
    expect(cloud.syncPreferences).not.toHaveBeenCalled();
  });

  it("C10: an invalid user id is a validation failure and the copy is not looked at", async () => {
    mockStored = { user: { id: USER }, preferencesCopy: COPY_A };

    const result = await get("");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation error");
    expect(mockLoadSession).not.toHaveBeenCalled();
    expect(cloud.getPreferences).not.toHaveBeenCalled();
  });
});
