/**
 * @jest-environment node
 */
/**
 * BACKLOG-3892 S5 — the backfill's IPC: the three channels are registered, a sync that
 * starts stops a running backfill, and no backfill is offered while a sync persists or a
 * texts force re-import runs. (The engine itself: iphoneBackfill-3892S5.test.ts.)
 */
import { EventEmitter } from "events";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn)),
    removeHandler: jest.fn((channel: string) => handlers.delete(channel)),
    removeAllListeners: jest.fn(),
    on: jest.fn(),
  },
  BrowserWindow: jest.fn(),
}));

const mockSync = jest.fn();
const mockOrchestrator = Object.assign(new (jest.requireActual("events").EventEmitter)(), {
  stopDeviceDetection: jest.fn(),
  getStatus: jest.fn(() => ({ isRunning: false, phase: "idle" })),
  sync: (...args: unknown[]) => mockSync(...args),
  forceReset: jest.fn(),
});
jest.mock("../../services/deviceDetectionService", () => ({ deviceDetectionService: new EventEmitter() }));
jest.mock("../../services/deviceSyncOrchestrator", () => ({
  deviceSyncOrchestrator: mockOrchestrator,
  DeviceSyncOrchestrator: class {},
}));
const mockPersist = jest.fn();
jest.mock("../../services/iPhoneSyncStorageService", () => ({
  iPhoneSyncStorageService: { persistSyncResult: (...a: unknown[]) => mockPersist(...a) },
  attachmentSkipFields: () => ({}),
}));
jest.mock("../../services/autoLinkService", () => ({
  autoLinkNewMessagesForUser: jest.fn().mockResolvedValue(undefined),
  expandAttachedThreadsForUser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/sessionService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/syncStatusService", () => ({ syncStatusService: {} }));
jest.mock("../../services/backupDecryptionService", () => ({
  backupDecryptionService: { sweepParseCopies: jest.fn().mockResolvedValue(0) },
}));
jest.mock("../../services/syncTimeline", () => ({
  syncTimeline: {
    markCompletionShown: jest.fn(),
    noteRendererTick: jest.fn(),
    markStorageCompleteSent: jest.fn(),
    enter: jest.fn(),
    annotate: jest.fn(),
    endSync: jest.fn(),
    currentPhase: jest.fn(),
  },
}));
jest.mock("../../services/iphoneChatFloorPlan", () => ({ floorPlanForSync: jest.fn().mockResolvedValue(undefined) }));
const mockForceReimport = jest.fn(() => false);
jest.mock("../../services/macOSMessagesImportService/macOSMessagesImportService", () => ({
  macOSMessagesImportService: { isForceReimportInProgress: () => mockForceReimport() },
}));
jest.mock("../../windowRegistry", () => ({ getMainWindow: jest.fn(), sendToMainWindow: jest.fn() }));

import { registerSyncHandlers, cleanupSyncHandlers, getIphoneBackfillForTests } from "../syncHandlers";
import { rateLimiters } from "../../utils/rateLimit";

const UDID = "00008030-0011223344556677";
const TXN = "6f1d2c3b-4a59-4e7f-8a1b-2c3d4e5f6a7b"; // pii-allow-uuid: invented, not from any live row

const call = (channel: string, ...args: unknown[]) => {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} was not registered`);
  return h({}, ...args);
};

describe("BACKLOG-3892 S5: backfill IPC", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    rateLimiters.sync.clearKey(UDID);
    mockForceReimport.mockReturnValue(false);
    registerSyncHandlers({} as never, "user-1");
    mockSync.mockResolvedValue({ success: false, messages: [], contacts: [], conversations: [], error: "x", duration: 1 });
  });
  afterEach(() => cleanupSyncHandlers());

  it("registers availability, run and cancel", () => {
    for (const c of ["sync:backfill-availability", "sync:backfill-older", "sync:backfill-cancel"]) expect(handlers.has(c)).toBe(true);
  });

  it("a sync that starts stops the running backfill", async () => {
    const cancel = jest.spyOn(getIphoneBackfillForTests(), "cancel");
    await call("sync:start", { udid: UDID });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it("not offered while a finished sync is still being stored, nor during a texts force re-import", async () => {
    let release!: (v: unknown) => void;
    mockPersist.mockReturnValue(new Promise((r) => (release = r)));
    mockSync.mockImplementation(async () => {
      const result = { success: true, messages: [], contacts: [], conversations: [], error: null, duration: 1 };
      mockOrchestrator.emit("complete", result);
      return result;
    });
    await call("sync:start", { udid: UDID });
    await new Promise((r) => setImmediate(r));
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(await call("sync:backfill-availability", TXN)).toEqual({ available: false, reason: "busy" });
    release({ success: true, messagesStored: 0, messagesSkipped: 0, contactsStored: 0, contactsSkipped: 0, attachmentsStored: 0, attachmentsSkipped: 0, duration: 0 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    mockForceReimport.mockReturnValue(true);
    expect(await call("sync:backfill-availability", TXN)).toEqual({ available: false, reason: "busy" });
    expect(await call("sync:backfill-older", TXN)).toMatchObject({ success: false, reason: "busy", messagesStored: 0 });
  });
});
