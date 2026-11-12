/**
 * @jest-environment node
 *
 * BACKLOG-3283: "Restart to update" must close the macOS main window even though
 * its `close` hides it. Native quitAndInstall closes windows BEFORE before-quit,
 * so nothing else sets the quitting flag in time.
 */
import { EventEmitter } from "events";

const handlers: Record<string, () => void> = {};
const quitAndInstall = jest.fn();

class FakeWindow extends EventEmitter {
  hidden = false;
  destroyed = false;
  hide() { this.hidden = true; }
  isFullScreen() { return false; }
  setFullScreen() {}
  isDestroyed() { return this.destroyed; }
  close() {
    let prevented = false;
    this.emit("close", { preventDefault: () => { prevented = true; } });
    if (!prevented) this.destroyed = true;
  }
}
let win: FakeWindow;

jest.mock("electron", () => ({
  ipcMain: { on: (ch: string, fn: () => void) => { handlers[ch] = fn; }, handle: jest.fn() },
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
jest.mock("../../windowRegistry", () => ({ getMainWindow: () => win }));
jest.mock("../syncHandlers", () => ({ stopBackupForQuit: () => null }));
jest.mock("../../services/atRest/backupAtRest", () => ({
  getBackupAtRest: () => ({ sealIndexForQuit: () => null }),
}));

import { registerUpdaterHandlers } from "../updaterHandlers";
import { attachHideOnClose } from "../../bootstrap/hideOnClose";
import { clearQuitting, isQuitting } from "../../bootstrap/quitState";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

/** A second hide-on-close window that install-update does not touch (removeAllListeners
 * only reaches the main window). Squirrel closes it from inside quitAndInstall. */
let other: FakeWindow;
let quittingAtCall: boolean | undefined;

beforeAll(() => registerUpdaterHandlers());
beforeEach(() => {
  clearQuitting();
  quittingAtCall = undefined;
  quitAndInstall.mockReset();
  quitAndInstall.mockImplementation(() => {
    quittingAtCall = isQuitting();
    other.close();
  });
  win = new FakeWindow();
  attachHideOnClose(win, "darwin");
  other = new FakeWindow();
  attachHideOnClose(other, "darwin");
});

describe("install-update closes a hide-on-close window (BACKLOG-3283)", () => {
  it("the window is closed (not hidden) before quitAndInstall", async () => {
    handlers["install-update"]();
    await flush();
    expect({ hidden: win.hidden, destroyed: win.destroyed }).toEqual({ hidden: false, destroyed: true });
    // First guard: the main window's close listeners (the hide one included) are stripped.
    expect(win.listenerCount("close")).toBe(0);
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("the quit is marked before quitAndInstall (a window Squirrel closes goes through)", async () => {
    handlers["install-update"]();
    await flush();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
    expect(quittingAtCall).toBe(true);
    expect({ hidden: other.hidden, destroyed: other.destroyed }).toEqual({ hidden: false, destroyed: true });
  });
});
