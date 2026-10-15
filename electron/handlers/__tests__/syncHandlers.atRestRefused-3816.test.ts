/**
 * BACKLOG-3816 S1 — an iPhone sync whose attachments were refused (no file-data
 * key) tells the renderer, instead of reporting a normal "storage complete".
 *
 * Drives the real `onSyncComplete` in syncHandlers through the orchestrator's
 * "complete" event (the way a sync ends), with persistSyncResult returning the
 * refusal shape iPhoneSyncStorageService produces (see
 * atRest.attachmentWriters-3816.test.ts "persistSyncResult reports the refusal").
 *
 * MUTATION: delete the `persistResult.atRestRefused` branch in syncHandlers.ts
 * -> red (the refusal falls through to "sync:storage-complete").
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

const MESSAGE = "Keepr could not open the key it uses to protect attachments saved on this computer …";

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("iPhone sync: attachments refused for want of the file-data key (BACKLOG-3816)", () => {
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

  it("sends sync:storage-error with the refusal message, and no storage-complete", async () => {
    await endSyncWith({ success: false, atRestRefused: true, error: MESSAGE, duration: 1 });

    expect(persistSyncResult).toHaveBeenCalled();
    const channels = send.mock.calls.map((c) => c[0]);
    expect(send).toHaveBeenCalledWith("sync:storage-error", { error: MESSAGE });
    expect(channels).not.toContain("sync:storage-complete");
  });

  it("CONTROL: a normal persistence still reports storage-complete", async () => {
    await endSyncWith({
      success: true, messagesStored: 1, messagesSkipped: 0, contactsStored: 0, contactsSkipped: 0,
      attachmentsStored: 0, attachmentsSkipped: 0, duration: 1,
    });

    const channels = send.mock.calls.map((c) => c[0]);
    expect(channels).toContain("sync:storage-complete");
    expect(channels).not.toContain("sync:storage-error");
  });
});
