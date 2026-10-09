/**
 * @jest-environment node
 *
 * BACKLOG-3785: "Restart to update" waits for in-flight links and a running iPhone
 * backup BEFORE quitAndInstall (on Windows the installer starts before the quit and
 * force-kills the app ~2.6 s later, so the before-quit deferral cannot help).
 */
const handlers: Record<string, () => void> = {};
const quitAndInstall = jest.fn();
const stopBackupForQuit = jest.fn();

jest.mock("electron", () => ({
  ipcMain: {
    on: (ch: string, fn: () => void) => { handlers[ch] = fn; },
    handle: jest.fn(),
  },
  app: { removeAllListeners: jest.fn(), getVersion: () => "0.0.0", isPackaged: false },
  shell: {},
  BrowserWindow: class {},
}));
jest.mock("electron-updater", () => ({
  autoUpdater: { quitAndInstall: (...a: unknown[]) => quitAndInstall(...a), on: jest.fn() },
}));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../services/failureLogService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/updaterFailureStore", () => ({ getRecentUpdaterFailure: jest.fn() }));
jest.mock("../../windowRegistry", () => ({ getMainWindow: () => null }));
jest.mock("../syncHandlers", () => ({ stopBackupForQuit: () => stopBackupForQuit() }));

import { registerUpdaterHandlers } from "../updaterHandlers";
import { beginLink } from "../../utils/linkInFlight";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

beforeAll(() => registerUpdaterHandlers({} as never));
beforeEach(() => {
  quitAndInstall.mockClear();
  stopBackupForQuit.mockReset().mockReturnValue(null);
});

describe("install-update waits before quitAndInstall (BACKLOG-3785)", () => {
  it("nothing in flight: installs", async () => {
    handlers["install-update"]();
    await flush();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("a link in flight: install is held until the link ends", async () => {
    const end = beginLink();
    handlers["install-update"]();
    await flush();
    expect(quitAndInstall).not.toHaveBeenCalled();
    end();
    await flush();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("an iPhone backup being stopped: install is held until it has stopped", async () => {
    let release!: () => void;
    stopBackupForQuit.mockReturnValue(new Promise<void>((r) => (release = r)));
    handlers["install-update"]();
    await flush();
    expect(quitAndInstall).not.toHaveBeenCalled();
    release();
    await flush();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("a backup stop that rejects still installs", async () => {
    stopBackupForQuit.mockReturnValue(Promise.reject(new Error("boom")));
    handlers["install-update"]();
    await flush();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
