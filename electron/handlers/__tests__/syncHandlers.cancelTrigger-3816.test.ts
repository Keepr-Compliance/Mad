/**
 * BACKLOG-3816 (phantom cancel): `sync:cancel` carries the control that asked for it.
 * The handler logs the trigger and whether the main window sent it, and hands the
 * orchestrator only a KNOWN trigger — anything else reaches `cancel(null)`, which the
 * orchestrator records as `cancel-unattributed` (deviceSyncOrchestrator.runEvidence-3440
 * and .backupAtRest-3816 cover that half).
 */
const orchestratorStub = {
  on: jest.fn(),
  removeAllListeners: jest.fn(),
  getStatus: jest.fn().mockReturnValue({ isRunning: false }),
  forceReset: jest.fn(),
  cancel: jest.fn(),
  watchBackupAtRestProgress: jest.fn(),
  startDeviceDetection: jest.fn(),
  stopDeviceDetection: jest.fn(),
};
const handlers = new Map<string, (...a: unknown[]) => unknown>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...a: unknown[]) => unknown) => handlers.set(channel, fn)),
    removeHandler: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
  },
  BrowserWindow: jest.fn(),
}));
jest.mock("electron-log", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../services/deviceSyncOrchestrator", () => ({
  deviceSyncOrchestrator: orchestratorStub,
  DeviceSyncOrchestrator: class {},
}));
jest.mock("../../services/iPhoneSyncStorageService", () => ({
  iPhoneSyncStorageService: { persistSyncResult: jest.fn() },
  attachmentSkipFields: jest.fn(() => ({})),
}));
jest.mock("../../services/autoLinkService", () => ({
  autoLinkNewMessagesForUser: jest.fn().mockResolvedValue(undefined),
  expandAttachedThreadsForUser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/sessionService", () => ({ __esModule: true, default: { loadSession: async () => null } }));
jest.mock("../../services/supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/syncStatusService", () => ({ syncStatusService: {} }));
jest.mock("../../services/syncTimeline", () => ({
  syncTimeline: {
    enter: jest.fn(),
    endSync: jest.fn(),
    annotate: jest.fn(),
    markStorageCompleteSent: jest.fn(),
    noteRendererTick: jest.fn(),
    markCompletionShown: jest.fn(),
    currentPhase: jest.fn(),
  },
}));

import log from "electron-log";
import { registerSyncHandlers, cleanupSyncHandlers } from "../syncHandlers";
import { setMainWindow } from "../../windowRegistry";

const MAIN_ID = 7;

describe("BACKLOG-3816: sync:cancel names its trigger", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    const win = { isDestroyed: () => false, webContents: { id: MAIN_ID, send: jest.fn() } };
    setMainWindow(win as never);
    registerSyncHandlers(win as never);
  });

  afterEach(() => {
    cleanupSyncHandlers();
    setMainWindow(null);
  });

  const cancel = (sender: number | undefined, trigger?: unknown) =>
    handlers.get("sync:cancel")?.(sender === undefined ? {} : { sender: { id: sender } }, trigger);

  it.each(["progress-cancel", "error-close", "try-again-no-device"])(
    "a known control (%s) reaches the orchestrator and is logged with its window",
    async (trigger) => {
      await cancel(MAIN_ID, trigger);
      expect(orchestratorStub.cancel).toHaveBeenCalledWith(trigger);
      expect(log.info).toHaveBeenCalledWith("[SyncHandlers] Cancelling sync", { trigger, fromMainWindow: true });
      expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("Cancelling sync"), expect.anything());
    },
  );

  it("no trigger: the orchestrator gets null and the log says so (warn)", async () => {
    await cancel(MAIN_ID);
    expect(orchestratorStub.cancel).toHaveBeenCalledWith(null);
    expect(log.warn).toHaveBeenCalledWith("[SyncHandlers] Cancelling sync with no known trigger", {
      trigger: "none",
      fromMainWindow: true,
    });
  });

  it("an unknown trigger from another window: null, and the log names the other window", async () => {
    await cancel(99, "window-close");
    expect(orchestratorStub.cancel).toHaveBeenCalledWith(null);
    expect(log.warn).toHaveBeenCalledWith("[SyncHandlers] Cancelling sync with no known trigger", {
      trigger: "unknown",
      fromMainWindow: false,
    });
  });
});
