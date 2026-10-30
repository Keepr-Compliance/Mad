/**
 * BACKLOG-3343 — an iPhone sync whose save FAILED (not cancelled, not the at-rest
 * refusal) is reported to the renderer as an error, never as "storage complete".
 *
 * Drives the real `onSyncComplete` in syncHandlers through the orchestrator's
 * "complete" event, with persistSyncResult returning the generic failure shape
 * iPhoneSyncStorageService's catch produces (success:false, error, zero counts).
 *
 * MUTATION: delete the generic `!persistResult.success` branch in syncHandlers.ts
 * -> red (the failure falls through to "sync:storage-complete").
 */
import { EventEmitter } from "events";

const orchestratorEvents = Object.assign(new EventEmitter(), {
  processExistingBackup: jest.fn().mockResolvedValue({ success: true }),
  getStatus: jest.fn().mockReturnValue({ isRunning: false }),
  forceReset: jest.fn(),
  cleanupBackup: jest.fn().mockResolvedValue(undefined),
  startDeviceDetection: jest.fn(),
  stopDeviceDetection: jest.fn(),
});
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const persistSyncResult = jest.fn();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...a: unknown[]) => unknown) => handlers.set(channel, fn)),
    removeHandler: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
  },
  BrowserWindow: jest.fn(),
}));
jest.mock("../../services/deviceSyncOrchestrator", () => ({
  deviceSyncOrchestrator: orchestratorEvents,
  DeviceSyncOrchestrator: class {},
}));
jest.mock("../../services/iPhoneSyncStorageService", () => ({
  iPhoneSyncStorageService: { persistSyncResult: (...a: unknown[]) => persistSyncResult(...a) },
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
  },
}));

import { registerSyncHandlers, setSyncUserId, cleanupSyncHandlers } from "../syncHandlers";
import { setMainWindow } from "../../windowRegistry";

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("iPhone sync: a failed save is reported as a failure (BACKLOG-3343)", () => {
  let send: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    orchestratorEvents.removeAllListeners();
    send = jest.fn();
    setMainWindow({ isDestroyed: () => false, webContents: { send } } as never);
    registerSyncHandlers({ isDestroyed: () => false, webContents: { send } } as never);
    setSyncUserId("user-1");
  });

  afterEach(() => {
    cleanupSyncHandlers();
    setMainWindow(null);
  });

  async function endSyncWith(persistResult: Record<string, unknown>): Promise<void> {
    persistSyncResult.mockResolvedValue(persistResult);
    await handlers.get("sync:process-existing")!({}, { udid: "0000-DEVICE" });
    orchestratorEvents.emit("complete", {
      success: true,
      messages: [],
      contacts: [],
      conversations: [],
      backupPath: "/backup",
      needsCleanup: false,
      error: null,
    });
    for (let i = 0; i < 10; i++) await flush();
  }

  it("a generic persistence failure sends sync:storage-error with the short copy, and no storage-complete", async () => {
    await endSyncWith({
      success: false,
      error: "disk I/O error",
      messagesStored: 0,
      messagesSkipped: 0,
      contactsStored: 0,
      contactsSkipped: 0,
      attachmentsStored: 0,
      attachmentsSkipped: 0,
      duration: 1,
    });
    const channels = send.mock.calls.map((c) => c[0]);
    expect(channels).not.toContain("sync:storage-complete");
    expect(send).toHaveBeenCalledWith("sync:storage-error", { error: "Saving the sync failed. Run the sync again." });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { syncTimeline } = require("../../services/syncTimeline");
    expect(syncTimeline.endSync).toHaveBeenCalledWith("error");
    expect(syncTimeline.endSync).not.toHaveBeenCalledWith("complete");
  });
});
