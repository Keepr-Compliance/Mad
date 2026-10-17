/**
 * @jest-environment node
 */
/**
 * BACKLOG-3657 (founder re-confirmed 2026-10-01) — Android's Force re-import
 * is SHARED: Google Messages' `rcs-import:clear-texts` clears BOTH Android
 * sources through ONE function (clearAllAndroidTexts): the Google Messages
 * texts first (with the cache's last sync and coverage reset), then the
 * texts and contacts the retired Android companion app wrote. iPhone / Mac
 * are never touched (real SQL: rcsClear-3657.test.ts F3).
 *
 * BACKLOG-3969: the companion app's desktop server is gone, so its own IPC
 * (`sync:clear-android-data`) is gone too. Its two deletes moved unchanged
 * into rcsImportHandlers.clearCompanionData; each is recorded here as its
 * own entry, with its source literal, so either one going missing or being
 * pointed at the wrong source is visible.
 *
 * Mutation controls (each turns a test red):
 *   F4 the IPC clearing one source only                      → "the IPC clears both sources"
 *   F5 the Google Messages cache state / coverage not reset  → "the IPC clears both sources"
 *      (SR 2026-10-02: incl. the per-chat coverage, rcs_chat_coverage)
 *   F6 a refused Google Messages clear still clearing the companion → "a refusal clears nothing"
 *   3969 (i) companion messages delete removed, (ii) companion contacts delete
 *      removed, (iii) "android_wifi_sync" changed to "android_sync"
 *                                                            → "the IPC clears both sources"
 */

export {};

const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>();
const calls: string[] = [];
let gmwebThrows: Error | null = null;

jest.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/tmp/keepr-test" },
  ipcMain: { handle: (channel: string, fn: (event: unknown, args?: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
  shell: { openExternal: jest.fn(async () => undefined) },
}));
jest.mock("../../services/rcsExtensionBridge", () => ({
  RcsExtensionBridge: class {
    writesArePaused = false;
    getStatus() {
      return { bridge: "listening", port: 1 };
    }
    activeJob() {
      return null;
    }
    activeJobUserId() {
      return null;
    }
    async pauseWrites() {
      calls.push("pause");
    }
    resumeWrites() {
      calls.push("resume");
    }
  },
}));
jest.mock("../../services/rcsClearService", () => {
  const actual = jest.requireActual("../../services/rcsClearService");
  return {
    ...actual,
    clearGoogleMessagesWebData: (_u: string, _db: unknown, _fs: unknown, _log: unknown, inside?: () => void) => {
      if (gmwebThrows) throw gmwebThrows;
      calls.push("clear google messages");
      // SR (G1): the cache records are cleared INSIDE the clear's transaction.
      if (inside) {
        calls.push("in the clear's transaction:");
        inside();
      }
      return { messagesDeleted: 50, linksDeleted: 4, filesDeleted: 2 };
    },
  };
});
jest.mock("../../services/db/externalContactDbService", () => ({
  deleteBySource: (userId: string, source: string) => {
    calls.push(`delete contacts ${userId} ${source}`);
    return 3;
  },
}));
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    rcsClearDbOps: () => ({}),
    resetRcsCacheState: (userId: string) => void calls.push(`reset cache state ${userId}`),
    deleteMessagesByMetadataSource: (userId: string, source: string) => {
      calls.push(`delete messages ${userId} ${source}`);
      return 12;
    },
    rcsStagingDbOps: () => ({
      deleteAll: () => undefined, journalRows: () => [], jobs: () => [], putJob: () => undefined, putChatMeta: () => undefined,
      // 3671 P3 (SR): Force re-import drops every staged run and the placed-files journal.
      deleteAllWithJournal: () => void calls.push("drop staging + journal"),
    }),
  },
}));
jest.mock("../../services/auditCoverageService", () => ({
  forgetSourceCoverage: (userId: string, source: string) => void calls.push(`forget coverage ${userId} ${source}`),
  getSourceCoverage: () => [],
  recordSourceCoverage: jest.fn(),
}));
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: async () => ({ user: { id: "user-1" } }) },
}));
jest.mock("../../services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../../services/autoLinkService", () => ({ autoLinkNewMessagesForUser: jest.fn() }));
jest.mock("../../services/messageMatchingService", () => ({ createCommunicationReference: jest.fn() }));
jest.mock("../../capabilities/windowsProvider", () => ({ hostWindows: { broadcast: jest.fn() } }));
jest.mock("../../utils/bringAppToFront", () => ({ bringAppToFront: jest.fn(), bringAppToFrontOrFlash: jest.fn() }));
jest.mock("../../windowRegistry", () => ({ getMainWindow: () => null }));
jest.mock("../../services/db/core/dbConnection", () => ({ dbTransaction: (fn: () => unknown) => fn() }));
let mockLastRun: unknown = null;
const mockRunRecords: unknown[] = [];
let mockPendingFull: string[] = [];
const mockPendingCleared: unknown[][] = [];
jest.mock("../../services/db/rcsPendingFullSyncDbService", () => ({
  listPendingFullRead: () => mockPendingFull,
  clearPendingFullRead: (...a: unknown[]) => void mockPendingCleared.push(a),
  clearAllPendingFullRead: jest.fn(),
}));
// SR (2026-10-02): Force re-import clears the per-chat coverage too.
jest.mock("../../services/db/rcsChatCoverageDbService", () => ({
  clearChatCoverage: (userId: string) => void calls.push("forget chat coverage " + userId),
  clearChatReads: (userId: string) => void calls.push("forget chat reads " + userId),
  clearFailedRun: (userId: string) => void calls.push("forget failed run " + userId),
  chatDoneInFailedRun: () => false,
  getChatRead: () => null,
  getFailedRun: () => null,
  setFailedRun: jest.fn(),
  dealChatStarts: () => new Map(),
  dealStartForChat: () => null,
  getChatCoverage: () => new Map(),
  latestConversationIds: () => new Map(),
  recordChatCoverage: jest.fn(),
}));
jest.mock("../../services/db/rcsCacheRunsDbService", () => ({
  recordRcsCacheRun: (_u: string, run: unknown) => void mockRunRecords.push(run),
  getRcsCacheRun: () => mockLastRun,
  clearRcsCacheRun: jest.fn(),
}));
jest.mock("../../utils/wrapHandler", () => ({
  wrapHandler: (fn: (event: unknown, args?: unknown) => Promise<unknown>) => fn,
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { registerRcsImportHandlers } = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");
/* eslint-enable @typescript-eslint/no-require-imports */

beforeAll(() => {
  registerRcsImportHandlers();
});
beforeEach(() => {
  calls.length = 0;
  gmwebThrows = null;
});

const BOTH = [
  "pause",
  "clear google messages",
  "in the clear's transaction:",
  "reset cache state user-1",
  "forget coverage user-1 google_messages",
  "forget chat coverage user-1",
  "drop staging + journal",
  "forget chat reads user-1",
  "forget failed run user-1",
  "resume",
  "delete messages user-1 android_wifi_sync",
  "delete contacts user-1 android_sync",
];

describe("Android's shared Force re-import (BACKLOG-3657)", () => {
  it("the IPC clears both sources, Google Messages first, then each companion delete (F4, F5, 3969)", async () => {
    const fromGoogleMessages = await handlers.get("rcs-import:clear-texts")!({});
    expect(calls).toEqual(BOTH);
    expect(fromGoogleMessages).toEqual({
      success: true, messagesDeleted: 50, linksDeleted: 4, filesDeleted: 2, androidMessagesDeleted: 12, contactsDeleted: 3,
    });
  });

  it("the companion's own clear channel is gone (3969)", () => {
    expect(handlers.has("sync:clear-android-data")).toBe(false);
  });

  it("a refusal clears nothing (F6)", async () => {
    gmwebThrows = new Error("Keepr is busy importing — try again in a moment.");
    const r = (await handlers.get("rcs-import:clear-texts")!({})) as { success: boolean; error?: string };
    expect(r).toEqual({ success: false, error: "Nothing was cleared. Keepr is busy importing — try again in a moment." });
    expect(calls.filter((c) => c.startsWith("delete "))).toEqual([]);
  });
});
