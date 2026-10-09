/**
 * BACKLOG-3816 S4-C — after a SUCCESSFUL sync the kept iPhone backup stays unsealed
 * while persistence copies attachments out of it. syncHandlers seals it (orchestrator
 * .completeBackupAtRest) when persistence ENDS, on every path: stored, cancelled,
 * refused (no file-data key), failed (throws), no user, and !success.
 *
 * MUTATION: move the completeBackupAtRest call into the success branch only → the
 * cancelled / refused / throws / no-user / !success tests go red.
 */
import { EventEmitter } from "events";

const order: string[] = [];
const orchestratorEvents = Object.assign(new EventEmitter(), {
  processExistingBackup: jest.fn().mockResolvedValue({ success: true }),
  getStatus: jest.fn().mockReturnValue({ isRunning: false }),
  forceReset: jest.fn(),
  cancel: jest.fn(),
  cleanupBackup: jest.fn(async () => {
    order.push("cleanup");
  }),
  completeBackupAtRest: jest.fn(async () => {
    order.push("seal");
  }),
  watchBackupAtRestProgress: jest.fn(),
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

const OK = {
  success: true, messagesStored: 1, messagesSkipped: 0, contactsStored: 0, contactsSkipped: 0,
  attachmentsStored: 0, attachmentsSkipped: 0, duration: 1,
};

describe("S4-C: the kept backup is sealed when persistence ends, on every path", () => {
  let send: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
    handlers.clear();
    orchestratorEvents.removeAllListeners();
    send = jest.fn();
    setMainWindow({ isDestroyed: () => false, webContents: { send } } as never);
    registerSyncHandlers({ isDestroyed: () => false, webContents: { send } } as never);
  });

  afterEach(() => {
    cleanupSyncHandlers();
    setMainWindow(null);
  });

  async function endSync(opts: { user?: boolean; success?: boolean; persist?: () => Promise<unknown> }): Promise<void> {
    persistSyncResult.mockImplementation(async () => {
      order.push("persist-start");
      try {
        return await (opts.persist ?? (async () => OK))();
      } finally {
        order.push("persist-end");
      }
    });
    if (opts.user !== false) {
      setSyncUserId("user-1");
      await handlers.get("sync:process-existing")!({}, { udid: "0000-DEVICE" });
    }
    orchestratorEvents.emit("complete", {
      success: opts.success !== false,
      messages: [],
      contacts: [],
      conversations: [],
      backupPath: "/backup",
      needsCleanup: true,
      error: null,
    });
    for (let i = 0; i < 20; i++) await flush();
  }

  it("stored: sealed once, AFTER persistence and the parse-copy cleanup", async () => {
    await endSync({});
    expect(order).toEqual(["persist-start", "persist-end", "cleanup", "seal"]);
    expect(orchestratorEvents.completeBackupAtRest).toHaveBeenLastCalledWith(true); // R1: only a stored sync may clear the force-full flag
  });

  it("persistence cancelled (the storage-error says partial data was cleaned up)", async () => {
    await endSync({
      persist: async () => {
        // the handler reads its own cancel signal; emulate by resolving the cancelled shape
        // after flipping it through the IPC the renderer uses
        await handlers.get("sync:cancel")?.({});
        return { success: false, duration: 1 };
      },
    });
    expect(send).toHaveBeenCalledWith("sync:storage-error", { error: "Sync cancelled — partial data has been cleaned up." });
    expect(order).toEqual(["persist-start", "persist-end", "cleanup", "seal"]);
    expect(orchestratorEvents.completeBackupAtRest).toHaveBeenLastCalledWith(false);
  });

  it("attachments refused (no file-data key)", async () => {
    await endSync({ persist: async () => ({ success: false, atRestRefused: true, error: "no key", duration: 1 }) });
    expect(order).toEqual(["persist-start", "persist-end", "cleanup", "seal"]);
    expect(orchestratorEvents.completeBackupAtRest).toHaveBeenLastCalledWith(false);
  });

  it("persistence throws", async () => {
    await endSync({ persist: async () => { throw new Error("db locked"); } });
    expect(order).toEqual(["persist-start", "persist-end", "cleanup", "seal"]);
    expect(orchestratorEvents.completeBackupAtRest).toHaveBeenLastCalledWith(false);
  });

  it("no user for persistence", async () => {
    await endSync({ user: false });
    expect(order).toEqual(["seal"]);
  });

  it("extraction did not succeed (nothing to persist)", async () => {
    await endSync({ success: false });
    expect(order).toEqual(["seal"]);
  });

  // SR-M7: `sendToMainWindow("sync:complete")` sits OUTSIDE persistCompletedSync's own
  // try. A throw there must still seal — only the handler's finally guarantees it.
  it("the completion message to the window throws: still sealed (the handler's finally)", async () => {
    send.mockImplementation((channel: string) => {
      if (channel === "sync:complete") throw new Error("window gone");
    });
    await endSync({});
    expect(order).toEqual(["seal"]);
    expect(orchestratorEvents.completeBackupAtRest).toHaveBeenCalledTimes(1);
  });

  it("registration subscribes the orchestrator to the at-rest progress (seal after sync, launch migration)", () => {
    expect(orchestratorEvents.watchBackupAtRestProgress).toHaveBeenCalledTimes(1);
  });
});
