/**
 * BACKLOG-3892 S1 — sync:start hands the orchestrator the floor plan it was given
 * by floorPlanForSync (resolved once per sync, for the session's user), and passes
 * NO floorPlan key at all when there is none (gated off / failed), so the
 * orchestrator runs today's full read.
 */

import { EventEmitter } from "events";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
    ),
    removeHandler: jest.fn(),
    removeAllListeners: jest.fn(),
    on: jest.fn(),
  },
  BrowserWindow: jest.fn(),
}));

const mockSync = jest.fn();
jest.mock("../../services/deviceDetectionService", () => ({
  deviceDetectionService: new EventEmitter(),
}));
jest.mock("../../services/deviceSyncOrchestrator", () => ({
  deviceSyncOrchestrator: Object.assign(new (jest.requireActual("events").EventEmitter)(), {
    stopDeviceDetection: jest.fn(),
    getStatus: jest.fn(() => ({ isRunning: false, phase: "idle" })),
    sync: (...args: unknown[]) => mockSync(...args),
    forceReset: jest.fn(),
  }),
  DeviceSyncOrchestrator: class {},
}));
jest.mock("../../services/iPhoneSyncStorageService", () => ({ iPhoneSyncStorageService: {} }));
jest.mock("../../services/autoLinkService", () => ({
  autoLinkNewMessagesForUser: jest.fn(),
  expandAttachedThreadsForUser: jest.fn(),
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
  },
}));

const mockFloorPlanForSync = jest.fn();
jest.mock("../../services/iphoneChatFloorPlan", () => ({
  floorPlanForSync: (...a: unknown[]) => mockFloorPlanForSync(...a),
}));

import { registerSyncHandlers, cleanupSyncHandlers } from "../syncHandlers";
import { rateLimiters } from "../../utils/rateLimit";

const UDID = "00008030-0011223344556677";

async function start(options: { udid: string }) {
  const handler = handlers.get("sync:start");
  if (!handler) throw new Error("sync:start was not registered");
  return handler({}, options);
}

describe("BACKLOG-3892 S1: sync:start passes the floor plan through", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    rateLimiters.sync.clearKey(UDID);
    registerSyncHandlers({} as never, "user-1");
    mockSync.mockResolvedValue({ success: false, messages: [], contacts: [], conversations: [], error: "x", duration: 1 });
  });
  afterEach(() => cleanupSyncHandlers());

  it("a plan is resolved for the session user and reaches orchestrator.sync", async () => {
    const plan = { settingsFloorMs: 1, handleFloors: new Map(), linkedChatFloors: new Map() };
    mockFloorPlanForSync.mockResolvedValue(plan);
    await start({ udid: UDID });
    expect(mockFloorPlanForSync).toHaveBeenCalledWith("user-1");
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync.mock.calls[0][0].floorPlan).toBe(plan);
  });

  it("no plan (gated off or failed): no floorPlan key, today's full read", async () => {
    mockFloorPlanForSync.mockResolvedValue(undefined);
    await start({ udid: UDID });
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync.mock.calls[0][0]).not.toHaveProperty("floorPlan");
    expect(mockSync.mock.calls[0][0]).toEqual({ udid: UDID, forceFullBackup: undefined });
  });
});
