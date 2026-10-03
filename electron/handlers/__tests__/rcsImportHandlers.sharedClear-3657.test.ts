/**
 * @jest-environment node
 */
/**
 * BACKLOG-3657 (founder re-confirmed 2026-10-01) — Android's Force re-import
 * is SHARED: from either Android section (Google Messages:
 * `rcs-import:clear-texts`; Android Companion: `sync:clear-android-data`) it
 * clears BOTH Android sources through ONE function (clearAllAndroidTexts):
 * the Google Messages texts first (with the cache's last sync and coverage
 * reset), then the companion's texts and contacts. iPhone / Mac are never
 * touched (real SQL: rcsClear-3657.test.ts F3).
 *
 * Mutation controls (each turns a test red):
 *   F4 either IPC clearing one source only                  → "both IPCs clear both sources"
 *   F5 the Google Messages cache state / coverage not reset  → "both IPCs clear both sources"
 *      (SR 2026-10-02: incl. the per-chat coverage, rcs_chat_coverage)
 *   F6 a refused Google Messages clear still clearing the companion → "a refusal clears nothing"
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
    clearGoogleMessagesWebData: () => {
      if (gmwebThrows) throw gmwebThrows;
      calls.push("clear google messages");
      return { messagesDeleted: 50, linksDeleted: 4, filesDeleted: 2 };
    },
  };
});
jest.mock("../../services/localSyncService", () => ({
  __esModule: true,
  default: {
    clearAndroidData: (userId: string) => {
      calls.push(`clear companion ${userId}`);
      return { messagesDeleted: 12, contactsDeleted: 3 };
    },
  },
}));
jest.mock("../../services/firewallService", () => ({ checkInboundFirewallAllowed: jest.fn() }));
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    rcsClearDbOps: () => ({}),
    resetRcsCacheState: (userId: string) => void calls.push(`reset cache state ${userId}`),
    rcsStagingDbOps: () => ({ deleteAll: () => undefined, journalRows: () => [] }),
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
const { registerLocalSyncHandlers } = require("../localSyncHandlers") as typeof import("../localSyncHandlers");
/* eslint-enable @typescript-eslint/no-require-imports */

beforeAll(() => {
  registerRcsImportHandlers();
  registerLocalSyncHandlers();
});
beforeEach(() => {
  calls.length = 0;
  gmwebThrows = null;
});

const BOTH = [
  "pause",
  "clear google messages",
  "reset cache state user-1",
  "forget coverage user-1 google_messages",
  "forget chat coverage user-1",
  "resume",
  "clear companion user-1",
];

describe("Android's shared Force re-import (BACKLOG-3657)", () => {
  it("both IPCs clear both sources, Google Messages first (F4, F5)", async () => {
    const fromGoogleMessages = await handlers.get("rcs-import:clear-texts")!({});
    expect(calls).toEqual(BOTH);
    expect(fromGoogleMessages).toEqual({
      success: true, messagesDeleted: 50, linksDeleted: 4, filesDeleted: 2, androidMessagesDeleted: 12, contactsDeleted: 3,
    });
    calls.length = 0;
    const fromCompanion = await handlers.get("sync:clear-android-data")!({}, { userId: "user-1" });
    expect(calls).toEqual(BOTH);
    expect(fromCompanion).toEqual({
      messagesDeleted: 12, contactsDeleted: 3, gmwebMessagesDeleted: 50, gmwebCleared: true, androidCleared: true,
    });
  });

  it("a refusal clears nothing (F6)", async () => {
    gmwebThrows = new Error("Keepr is busy importing — try again in a moment.");
    const r = (await handlers.get("rcs-import:clear-texts")!({})) as { success: boolean; error?: string };
    expect(r).toEqual({ success: false, error: "Nothing was cleared. Keepr is busy importing — try again in a moment." });
    expect(calls).not.toContain("clear companion user-1");
  });
});
