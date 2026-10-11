/**
 * BACKLOG-3785 — the `sync:start` reply must stay small, whatever the sync found.
 *
 * The orchestrator's result carries every message, contact and conversation. When the
 * handler returned it as the invoke reply, Electron structured-cloned it to the renderer
 * and decoded it on the renderer's main thread: 179,140,037 bytes for 670k messages, an
 * 83.6 s frozen window on a Mac. The renderer reads only `success` / `error`; storage
 * gets the full result in main through the orchestrator's "complete" event.
 *
 * Size is measured with `v8.serialize`, the same encoding Electron uses for the reply.
 */

import v8 from "v8";

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
const mockProcessExisting = jest.fn();
jest.mock("../../services/deviceDetectionService", () => ({
  deviceDetectionService: new EventEmitter(),
}));
jest.mock("../../services/deviceSyncOrchestrator", () => ({
  deviceSyncOrchestrator: Object.assign(new (jest.requireActual("events").EventEmitter)(), {
    stopDeviceDetection: jest.fn(),
    getStatus: jest.fn(() => ({ isRunning: false, phase: "idle" })),
    sync: (...args: unknown[]) => mockSync(...args),
    processExistingBackup: (...args: unknown[]) => mockProcessExisting(...args),
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

import { registerSyncHandlers, cleanupSyncHandlers, toSyncReply } from "../syncHandlers";
import { rateLimiters } from "../../utils/rateLimit";
import type { SyncResult } from "../../services/deviceSyncOrchestrator";

const UDID = "00008030-0011223344556677";
const MAX_REPLY_BYTES = 4 * 1024;

/** A result the size of a real large phone: 100k messages over 2,000 conversations. */
function bigResult(over: Partial<SyncResult> = {}): SyncResult {
  const conversations = Array.from({ length: 2000 }, (_, c) => ({
    chatId: c,
    guid: `chat-${c}`,
    messages: Array.from({ length: 50 }, (_, m) => ({
      id: c * 50 + m,
      guid: `msg-${c}-${m}`,
      text: `message ${m} in conversation ${c} with some ordinary length body text`,
      date: new Date(1_700_000_000_000 + m * 1000).toISOString(),
      isFromMe: m % 2 === 0,
      handle: `+1555000${String(c).padStart(4, "0")}`,
    })),
  }));
  const messages = conversations.flatMap((c) => c.messages);
  const contacts = Array.from({ length: 1200 }, (_, i) => ({ id: i, firstName: `First${i}`, lastName: `Last${i}` }));
  return {
    success: true,
    messages,
    contacts,
    conversations,
    error: null,
    duration: 12_345,
    backupPath: "/tmp/backup",
    needsCleanup: true,
    sessionId: "session-1",
    ...over,
  } as unknown as SyncResult;
}

async function invoke(channel: "sync:start" | "sync:process-existing", options: { udid: string; password?: string }) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  return (await handler({}, options)) as Record<string, unknown>;
}

describe("BACKLOG-3785: the sync reply carries counts, never the arrays", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    rateLimiters.sync.clearKey(UDID);
    registerSyncHandlers({} as never, "user-1");
  });
  afterEach(() => cleanupSyncHandlers());

  it("the fixture really is large: the full result serialises to well over 1 MB", () => {
    // If this ever fails, the size assertions below prove nothing.
    expect(v8.serialize(bigResult()).byteLength).toBeGreaterThan(1024 * 1024);
    expect(bigResult().messages).toHaveLength(100_000);
  });

  it.each(["sync:start", "sync:process-existing"] as const)(
    "%s: a 100k-message sync replies in under 4 KB, with no message, contact or conversation arrays",
    async (channel) => {
      mockSync.mockResolvedValue(bigResult());
      mockProcessExisting.mockResolvedValue(bigResult());
      const reply = await invoke(channel, { udid: UDID });
      expect(reply.success).toBe(true);
      expect(v8.serialize(reply).byteLength).toBeLessThan(MAX_REPLY_BYTES);
      expect(reply).not.toHaveProperty("messages");
      expect(reply).not.toHaveProperty("contacts");
      expect(reply).not.toHaveProperty("conversations");
      expect(reply).toMatchObject({ messageCount: 100_000, contactCount: 1200, conversationCount: 2000 });
    },
  );

  it("main-only fields stay in main (the backup path is never sent to the renderer)", async () => {
    mockSync.mockResolvedValue(bigResult());
    const reply = await invoke("sync:start", { udid: UDID });
    expect(reply).not.toHaveProperty("backupPath");
    expect(reply).not.toHaveProperty("needsCleanup");
    expect(reply).not.toHaveProperty("sessionId");
  });

  it("every scalar the renderer can read passes through unchanged", async () => {
    mockSync.mockResolvedValue(
      bigResult({
        success: false,
        error: "Backup password required",
        duration: 77,
        skipped: true,
        skipReason: "unchanged",
        appleEncryptedBackup: true,
        attachmentsUndecryptable: 3,
      }),
    );
    const reply = await invoke("sync:start", { udid: UDID });
    expect(reply).toEqual({
      success: false,
      error: "Backup password required",
      duration: 77,
      messageCount: 100_000,
      contactCount: 1200,
      conversationCount: 2000,
      skipped: true,
      skipReason: "unchanged",
      appleEncryptedBackup: true,
      attachmentsUndecryptable: 3,
    });
  });

  it("the rate-limited reply keeps rateLimited and the error, and is small", async () => {
    mockSync.mockResolvedValue({ ...bigResult(), success: false, error: "lost" });
    await invoke("sync:start", { udid: UDID });
    const second = await invoke("sync:start", { udid: UDID });
    expect(second.rateLimited).toBe(true);
    expect(second.success).toBe(false);
    expect(String(second.error)).toMatch(/^Please wait \d+ seconds/);
    expect(v8.serialize(second).byteLength).toBeLessThan(MAX_REPLY_BYTES);
  });

  it("a thrown sync replies small, with the error", async () => {
    mockSync.mockRejectedValue(new Error("device went away"));
    const reply = await invoke("sync:start", { udid: UDID });
    expect(reply).toMatchObject({ success: false, error: "device went away", messageCount: 0 });
    expect(reply).not.toHaveProperty("messages");
  });

  it("storage still gets the full result: building the reply leaves the result intact", () => {
    const result = bigResult();
    toSyncReply(result);
    expect(result.messages).toHaveLength(100_000);
    expect(result.conversations).toHaveLength(2000);
    expect(result.backupPath).toBe("/tmp/backup");
  });
});
