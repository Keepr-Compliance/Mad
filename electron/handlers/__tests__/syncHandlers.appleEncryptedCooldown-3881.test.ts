/**
 * BACKLOG-3881 — the per-phone sync cooldown must not refuse the user's next Sync after a
 * run stopped because the iPhone's backups are Apple-encrypted (that run transferred
 * nothing). And `sync:start` never passes a password on, whatever the renderer sends.
 * A run that did real work (or failed for another reason) keeps the cooldown.
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

import { registerSyncHandlers, cleanupSyncHandlers } from "../syncHandlers";
import { rateLimiters } from "../../utils/rateLimit";

const UDID = "00008030-0011223344556677";

function failed(over: Record<string, unknown> = {}) {
  return { success: false, messages: [], contacts: [], conversations: [], error: "x", duration: 1, ...over };
}

async function start(options: { udid: string; password?: string }) {
  const handler = handlers.get("sync:start");
  if (!handler) throw new Error("sync:start was not registered");
  return (await handler({}, options)) as { success: boolean; error: string | null; rateLimited?: boolean };
}

describe("BACKLOG-3881: sync cooldown vs. an Apple-encrypted backup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    rateLimiters.sync.clearKey(UDID);
    registerSyncHandlers({} as never, "user-1");
  });
  afterEach(() => cleanupSyncHandlers());

  it("a run stopped by an Apple-encrypted backup: the next Sync, inside the cooldown, is allowed", async () => {
    mockSync
      .mockResolvedValueOnce(failed({ error: "Your iPhone backups are password-protected by Apple.", appleEncryptedBackup: true }))
      .mockResolvedValueOnce({ ...failed(), success: true, error: null });
    await start({ udid: UDID });
    const next = await start({ udid: UDID });
    expect(next.rateLimited).toBeUndefined();
    expect(mockSync).toHaveBeenCalledTimes(2);
  });

  it("a password sent by an old renderer never reaches the orchestrator", async () => {
    mockSync.mockResolvedValue({ ...failed(), success: true, error: null });
    await start({ udid: UDID, password: "left-over" });
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync.mock.calls[0][0]).not.toHaveProperty("password");
    expect(mockSync.mock.calls[0][0].udid).toBe(UDID);
  });

  it("a run that failed for any other reason keeps the cooldown", async () => {
    mockSync.mockResolvedValue(failed({ error: "lost" }));
    await start({ udid: UDID });
    const second = await start({ udid: UDID });
    expect(second.rateLimited).toBe(true);
    expect(second.error).toMatch(/^Please wait \d+ seconds/);
    expect(mockSync).toHaveBeenCalledTimes(1);
  });
});
