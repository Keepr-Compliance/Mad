/**
 * @jest-environment node
 */

/**
 * BACKLOG-3469: the Settings "Auto-download Updates" switch drives the real
 * updater flag (autoUpdater.autoDownload), default ON.
 *
 * C2  startup: the stored value is applied BEFORE the update check is called
 * C3  startup: every missing leg (no session, expired, no copy, other user,
 *     no field, slow read, error) defaults to ON; only an explicit false is OFF
 * C4  Store build: app:download-update refuses and never downloads
 * C5  switch OFF: the error-recovery path never re-downloads
 * C7  preferences:update / preferences:get apply the value to the updater
 * Text checks pin main.ts's wiring (main.ts has no seam a behavioural test can
 * load; same approach as selfUpdatePolicy-3927).
 *
 * Real: updateDownloadPolicy, preferencesMirror, preferenceHandlers,
 * updaterHandlers, updaterRetryPolicy. Stand-ins: electron, electron-updater,
 * the session file, the cloud.
 */

import * as fs from "fs";
import * as path from "path";
import type { IpcMainInvokeEvent } from "electron";

type Handler = (...args: unknown[]) => unknown;
const mockHandles: Record<string, Handler> = {};
const mockOns: Record<string, Handler> = {};

jest.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, fn: Handler) => {
      mockHandles[ch] = fn;
    },
    on: (ch: string, fn: Handler) => {
      mockOns[ch] = fn;
    },
  },
  app: { removeAllListeners: jest.fn(), getVersion: () => "2.46.0", isPackaged: true },
  shell: { openExternal: jest.fn() },
  BrowserWindow: class {},
}));

const mockDownloadUpdate = jest.fn(() => Promise.resolve([] as string[]));
const mockUpdater = {
  autoDownload: true,
  checkForUpdates: jest.fn(),
  downloadUpdate: () => mockDownloadUpdate(),
  quitAndInstall: jest.fn(),
  on: jest.fn(),
};
jest.mock("electron-updater", () => ({ autoUpdater: mockUpdater }));

jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../failureLogService", () => ({ __esModule: true, default: { logFailure: jest.fn() } }));
jest.mock("../updaterFailureStore", () => ({ getRecentUpdaterFailure: jest.fn() }));
jest.mock("../../windowRegistry", () => ({ getMainWindow: () => null }));
jest.mock("../../handlers/syncHandlers", () => ({ stopBackupForQuit: () => null }));
jest.mock("../atRest/backupAtRest", () => ({
  getBackupAtRest: () => ({ sealIndexForQuit: () => null }),
}));
let mockStore = false;
jest.mock("../distributionChannelService", () => ({ isStoreBuild: () => mockStore }));

// Session file stand-in: peekSession (read-only) and loadSession read the same object.
type Session = Record<string, unknown>;
let mockStored: Session | null = null;
let mockPeekImpl: (() => Promise<unknown>) | null = null;
const mockPeek = jest.fn(async () =>
  mockPeekImpl ? mockPeekImpl() : mockStored ? { status: "ok", session: mockStored } : { status: "none" },
);
jest.mock("../sessionService", () => ({
  __esModule: true,
  default: {
    peekSession: () => mockPeek(),
    loadSession: jest.fn(async () => mockStored),
    updateSession: jest.fn(async () => true),
    getGeneration: () => 1,
  },
}));

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: jest.fn(), syncPreferences: jest.fn(), getAuthUserId: jest.fn() },
}));

import {
  autoDownloadFromPreferences,
  readStoredAutoDownload,
  recoveryMayDownload,
  runStartupUpdateCheck,
} from "../updateDownloadPolicy";
import { createRetryState, decideRecovery, executeRecovery } from "../updaterRetryPolicy";
import { registerPreferenceHandlers } from "../../handlers/preferenceHandlers";
import { registerUpdaterHandlers } from "../../handlers/updaterHandlers";
import { STORE_UPDATES_MESSAGE } from "../selfUpdatePolicy";
import supabaseService from "../supabaseService";

const cloud = supabaseService as jest.Mocked<typeof supabaseService>;

// pii-allow-uuid: invented, not from any live row
const USER = "00000000-0000-4000-8000-000000000001";
// pii-allow-uuid: invented, not from any live row
const OTHER_USER = "00000000-0000-4000-8000-000000000002";

function sessionWith(prefs: Record<string, unknown> | null, opts: { userId?: string; expiresAt?: number } = {}): Session {
  const s: Session = { user: { id: opts.userId ?? USER }, expiresAt: opts.expiresAt ?? Date.now() + 3_600_000 };
  if (prefs) {
    s.preferencesCopy = { userId: USER, preferences: prefs, copiedAt: "2026-11-01T10:00:00.000Z" };
  }
  return s;
}

beforeAll(() => {
  registerPreferenceHandlers();
  registerUpdaterHandlers({} as never);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStored = null;
  mockPeekImpl = null;
  mockStore = false;
  mockUpdater.autoDownload = true;
});

describe("autoDownloadFromPreferences: default ON", () => {
  it.each([
    [undefined, true],
    [null, true],
    [{}, true],
    [{ updates: {} }, true],
    [{ updates: { autoDownload: "false" } }, true],
    [{ updates: { autoDownload: true } }, true],
    [{ updates: { autoDownload: false } }, false],
  ])("%j -> %s", (bag, expected) => {
    expect(autoDownloadFromPreferences(bag)).toBe(expected);
  });
});

describe("C3 startup read: only an explicit stored false is OFF", () => {
  it("stored false -> false", async () => {
    mockStored = sessionWith({ updates: { autoDownload: false } });
    await expect(readStoredAutoDownload()).resolves.toBe(false);
  });

  it.each<[string, () => void]>([
    ["no session file", () => { mockStored = null; }],
    ["unreadable session", () => { mockPeekImpl = async () => ({ status: "unreadable" }); }],
    ["expired session", () => { mockStored = sessionWith({ updates: { autoDownload: false } }, { expiresAt: Date.now() - 1000 }); }],
    ["session without a copy", () => { mockStored = sessionWith(null); }],
    ["copy for another user", () => { mockStored = sessionWith({ updates: { autoDownload: false } }, { userId: OTHER_USER }); }],
    ["copy without the field", () => { mockStored = sessionWith({ export: { defaultFormat: "pdf" } }); }],
    ["peek throws", () => { mockPeekImpl = async () => { throw new Error("boom"); }; }],
  ])("%s -> ON", async (_label, arrange) => {
    arrange();
    await expect(readStoredAutoDownload()).resolves.toBe(true);
  });

  it("read slower than the timeout -> ON", async () => {
    mockPeekImpl = () => new Promise(() => { /* never resolves */ });
    await expect(readStoredAutoDownload(20)).resolves.toBe(true);
  });
});

describe("C2 startup ordering: the flag is set before the check is called", () => {
  it("stored false: the check sees autoDownload === false at call time", async () => {
    mockStored = sessionWith({ updates: { autoDownload: false } });
    const updater = { autoDownload: true };
    const seenAtCall: boolean[] = [];
    await runStartupUpdateCheck(updater, () => {
      seenAtCall.push(updater.autoDownload);
      return null;
    });
    expect(seenAtCall).toEqual([false]);
  });

  it("the check is not called until the stored read has finished", async () => {
    let release!: (v: unknown) => void;
    mockPeekImpl = () => new Promise((r) => { release = r; });
    const updater = { autoDownload: true };
    const runCheck = jest.fn(() => updater.autoDownload);
    const done = runStartupUpdateCheck(updater, runCheck, 5_000);
    await new Promise((r) => setImmediate(r));
    expect(runCheck).not.toHaveBeenCalled();
    mockStored = sessionWith({ updates: { autoDownload: false } });
    release({ status: "ok", session: mockStored });
    await expect(done).resolves.toBe(false);
    expect(runCheck).toHaveBeenCalledTimes(1);
  });

  it("no stored value: the check sees ON", async () => {
    const updater = { autoDownload: false };
    const seen = await runStartupUpdateCheck(updater, () => updater.autoDownload);
    expect(seen).toBe(true);
  });
});

describe("C5 recovery with the switch OFF never downloads", () => {
  it.each(["network_timeout", "checksum_mismatch"] as const)("%s: no re-download", (errorType) => {
    const updater = { autoDownload: false, disableDifferentialDownload: false, downloadUpdate: jest.fn(() => Promise.resolve()) };
    const state = createRetryState();
    const decision = decideRecovery(errorType, state, recoveryMayDownload(updater, true));
    const recovered = executeRecovery(decision, state, updater, { schedule: (fn) => fn() });
    expect(recovered).toBe(false);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("switch ON (control): recovery re-downloads", () => {
    const updater = { autoDownload: true, disableDifferentialDownload: false, downloadUpdate: jest.fn(() => Promise.resolve()) };
    const state = createRetryState();
    const decision = decideRecovery("network_timeout", state, recoveryMayDownload(updater, true));
    expect(executeRecovery(decision, state, updater, { schedule: (fn) => fn() })).toBe(true);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("no update offered this cycle: no recovery even with the switch ON", () => {
    expect(recoveryMayDownload({ autoDownload: true }, false)).toBe(false);
  });
});

describe("C4 app:download-update", () => {
  it("Store build: refused, never downloads", async () => {
    mockStore = true;
    const result = await mockHandles["app:download-update"]();
    expect(result).toEqual({ success: false, error: STORE_UPDATES_MESSAGE });
    expect(mockDownloadUpdate).not.toHaveBeenCalled();
  });

  it("website build: downloads once", async () => {
    const result = await mockHandles["app:download-update"]();
    expect(result).toEqual({ success: true });
    expect(mockDownloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("website build: a rejected download is handled, not left unhandled", async () => {
    mockDownloadUpdate.mockImplementationOnce(() => Promise.reject(new Error("net")));
    const result = await mockHandles["app:download-update"]();
    expect(result).toEqual({ success: true });
    await new Promise((r) => setImmediate(r));
  });
});

describe("C7 preference handlers apply the switch to the updater", () => {
  const event = {} as IpcMainInvokeEvent;

  it("preferences:update OFF sets autoDownload false, even when the cloud save fails", async () => {
    cloud.getPreferences.mockResolvedValue({});
    cloud.syncPreferences.mockRejectedValue(new Error("offline"));
    const result = (await mockHandles["preferences:update"](event, USER, {
      updates: { autoDownload: false },
    })) as { success: boolean };
    expect(result.success).toBe(false);
    expect(mockUpdater.autoDownload).toBe(false);
  });

  it("preferences:update ON sets autoDownload true", async () => {
    mockUpdater.autoDownload = false;
    cloud.getPreferences.mockResolvedValue({});
    cloud.syncPreferences.mockResolvedValue(undefined);
    await mockHandles["preferences:update"](event, USER, { updates: { autoDownload: true } });
    expect(mockUpdater.autoDownload).toBe(true);
  });

  it("preferences:update without the field leaves the flag alone", async () => {
    mockUpdater.autoDownload = false;
    cloud.getPreferences.mockResolvedValue({});
    cloud.syncPreferences.mockResolvedValue(undefined);
    await mockHandles["preferences:update"](event, USER, { sync: { autoSyncOnLogin: true } });
    expect(mockUpdater.autoDownload).toBe(false);
  });

  it("preferences:get applies the cloud value (false) and the default (ON)", async () => {
    cloud.getPreferences.mockResolvedValueOnce({ updates: { autoDownload: false } });
    await mockHandles["preferences:get"](event, USER);
    expect(mockUpdater.autoDownload).toBe(false);
    cloud.getPreferences.mockResolvedValueOnce({});
    await mockHandles["preferences:get"](event, USER);
    expect(mockUpdater.autoDownload).toBe(true);
  });

  it("preferences:get offline applies the local copy's value", async () => {
    cloud.getPreferences.mockRejectedValue(new Error("offline"));
    mockStored = sessionWith({ updates: { autoDownload: false } });
    const result = (await mockHandles["preferences:get"](event, USER)) as { source?: string };
    expect(result.source).toBe("copy");
    expect(mockUpdater.autoDownload).toBe(false);
  });
});

const MAIN = fs.readFileSync(path.resolve(__dirname, "../../main.ts"), "utf8");

describe("main.ts wiring (text)", () => {
  it("the startup check runs inside runStartupUpdateCheck's callback", () => {
    expect(MAIN).toMatch(
      /runStartupUpdateCheck\(autoUpdater, \(\) =>\s*checkForUpdatesUnlessStore\(autoUpdater, "startup"\)/,
    );
    expect(MAIN.match(/checkForUpdatesUnlessStore\(autoUpdater, "startup"\)/g)).toHaveLength(1);
  });

  it("recovery is gated on the switch", () => {
    expect(MAIN).toMatch(
      /decideRecovery\(\s*errorType,\s*updaterRetryState,\s*recoveryMayDownload\(autoUpdater, updaterDownloadStarted\),?\s*\)/,
    );
  });

  it("update-available tells the renderer whether the download starts by itself", () => {
    expect(MAIN).toMatch(
      /send\("update-available", \{\s*\.\.\.info,\s*autoDownload: autoUpdater\.autoDownload,?\s*\}\)/,
    );
  });

  it("autoInstallOnAppQuit is never assigned", () => {
    expect(MAIN).not.toMatch(/autoInstallOnAppQuit\s*=/);
  });
});
