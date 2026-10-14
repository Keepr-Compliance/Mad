/**
 * @jest-environment node
 *
 * BACKLOG-3927: in the Microsoft Store build the updater IPC never contacts the
 * update feed, never installs, and never opens the website installer.
 */
const handles: Record<string, (...a: unknown[]) => unknown> = {};
const ons: Record<string, (...a: unknown[]) => unknown> = {};
const checkForUpdates = jest.fn();
const quitAndInstall = jest.fn();
const openExternal = jest.fn();

jest.mock("electron", () => ({
  ipcMain: {
    on: (ch: string, fn: () => void) => { ons[ch] = fn; },
    handle: (ch: string, fn: () => void) => { handles[ch] = fn; },
  },
  app: { removeAllListeners: jest.fn(), getVersion: () => "2.41.0", isPackaged: true },
  shell: { openExternal: (...a: unknown[]) => openExternal(...a) },
  BrowserWindow: class {},
}));
jest.mock("electron-updater", () => ({
  autoUpdater: {
    checkForUpdates: (...a: unknown[]) => checkForUpdates(...a),
    quitAndInstall: (...a: unknown[]) => quitAndInstall(...a),
    on: jest.fn(),
  },
}));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn() }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../services/failureLogService", () => ({ __esModule: true, default: { logFailure: jest.fn() } }));
jest.mock("../../services/updaterFailureStore", () => ({ getRecentUpdaterFailure: jest.fn() }));
jest.mock("../../windowRegistry", () => ({ getMainWindow: () => null }));
jest.mock("../syncHandlers", () => ({ stopBackupForQuit: () => null }));
jest.mock("../../services/atRest/backupAtRest", () => ({
  getBackupAtRest: () => ({ sealIndexForQuit: () => null }),
}));
let mockStore = true;
jest.mock("../../services/distributionChannelService", () => ({ isStoreBuild: () => mockStore }));

import { registerUpdaterHandlers } from "../updaterHandlers";
import { STORE_UPDATES_MESSAGE } from "../../services/selfUpdatePolicy";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

beforeAll(() => registerUpdaterHandlers({} as never));
beforeEach(() => {
  jest.clearAllMocks();
  mockStore = true;
});

describe("Store build updater IPC (BACKLOG-3927)", () => {
  it("app:check-for-updates: no feed contact, says updates come from the Store", async () => {
    const result = await handles["app:check-for-updates"]();
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(result).toEqual({
      updateAvailable: false,
      currentVersion: "2.41.0",
      error: STORE_UPDATES_MESSAGE,
      storeBuild: true,
    });
  });

  it("install-update: never installs", async () => {
    ons["install-update"]();
    await flush();
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it("app:open-manual-installer: never opens the website installer", async () => {
    const result = await handles["app:open-manual-installer"]();
    expect(openExternal).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: STORE_UPDATES_MESSAGE });
  });

  it("website build (control): the manual check still contacts the feed", async () => {
    mockStore = false;
    checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: "2.41.0" } });
    const result = await handles["app:check-for-updates"]();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ updateAvailable: false, currentVersion: "2.41.0" });
  });
});
