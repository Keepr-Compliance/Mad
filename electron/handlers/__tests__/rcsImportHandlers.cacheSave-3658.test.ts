/**
 * @jest-environment node
 */
/**
 * BACKLOG-3658 (SR B1, S1) — a finished cache Sync is saved (commit +
 * auto-link) AFTER its job slot is free. Until it is done, Keepr is busy: a
 * new cache Sync, a transaction Sync and Force re-import are refused, so none
 * of them can sweep the staging or write the same content-addressed files.
 * Open views are told to refetch only once the texts are saved AND linked.
 *
 * Mutation controls (each turns a test red):
 *   B1a cacheSaveInFlight always false                  → "busy while saving"
 *   B1b the counter set only after an await (too late)   → "busy while saving"
 *   S1  the refresh broadcast dropped / sent before link → "refresh after save"
 *   T1  no save timeout (a hung commit keeps Keepr busy) → "a hung save"
 *   H4  the saved counts not handed to the bridge after the commit       → "saved counts"
 *   F1  Keepr not brought forward when a Sync is done or failed, or brought
 *       forward on a cancel                                          → "comes to the front"
 *   C3663 coverage recorded for a run that did not reach its floor, or never → "coverage"
 */

export {};

const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>();
const broadcasts: Array<[string, unknown]> = [];
const order: string[] = [];
let bridgeOptions: Record<string, (...a: unknown[]) => unknown> = {};
let releaseCommit: (() => void) | null = null;
const abandoned: string[] = [];
const coverageWrites: Array<[string, string, string | null]> = [];
const savedRecords: Array<[string, unknown]> = [];

jest.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/tmp/keepr-test" },
  ipcMain: { handle: (channel: string, fn: (event: unknown, args?: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
  shell: { openExternal: jest.fn(async () => undefined) },
}));
jest.mock("../../services/rcsExtensionBridge", () => ({
  RcsExtensionBridge: class {
    writesArePaused = false;
    constructor(options: Record<string, (...a: unknown[]) => unknown>) {
      bridgeOptions = options;
    }
    getStatus() {
      return { bridge: "listening", port: 1 };
    }
    activeJob() {
      return null;
    }
    activeJobUserId() {
      return null;
    }
    createCacheJob() {
      return { jobId: "job-1", kind: "cache", state: "created" };
    }
    recordCacheSaved(jobId: string, saved: unknown) {
      savedRecords.push([jobId, saved]);
    }
  },
}));
jest.mock("../../services/rcsCacheStaging", () => ({
  RcsCacheStaging: class {
    isCommitting = false;
    async discardAll() {}
    async discard() {}
    async abandon(jobId: string) {
      abandoned.push(jobId);
    }
    commit(_j: string, _u: string, _l: unknown, _w: unknown, inside?: (r: unknown) => void) {
      order.push("commit");
      return new Promise((resolve) => {
        releaseCommit = () => {
          const r = { staged: 1, kept: 1, droppedByDate: 0, droppedByCap: 0, chats: 1, stored: 1, alreadyPresent: 0, imagesStaged: 0, imagesStored: 0 };
          inside?.(r);
          resolve(r);
        };
      });
    }
  },
}));
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    getRcsCacheState: () => ({ optedInAt: "2026-09-01T00:00:00.000Z", lastCacheFinishedAt: null, ownNumber: null }),
    getRcsConsent: () => ({ consentAt: "2026-09-01T00:00:00.000Z", consentVersion: 1, contactsOnly: false, autoDeleteDays: null }),
    updateRcsCacheState: () => undefined,
    rcsStagingDbOps: () => ({}),
    getTransactionById: async () => ({ id: "tx-1", user_id: "user-1" }),
    getRcsImportContacts: () => [],
  },
}));
jest.mock("../../services/auditCoverageService", () => ({
  getSourceCoverage: () => [],
  forgetSourceCoverage: jest.fn(),
  recordSourceCoverage: (userId: string, source: string, coveredSince: string | null) =>
    void coverageWrites.push([userId, source, coveredSince]),
}));
jest.mock("../../services/importPlanInputs", () => ({
  resolveImportPlanForUser: async () => ({ fetchStartISO: "2026-07-01T00:00:00.000Z", effectiveCap: 50000, protectedSpans: [] }),
}));
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: async () => ({ user: { id: "user-1" } }) },
}));
jest.mock("../../services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../../services/autoLinkService", () => ({
  autoLinkNewMessagesForUser: jest.fn(async () => {
    order.push("autolink");
  }),
}));
jest.mock("../../services/messageMatchingService", () => ({ createCommunicationReference: jest.fn() }));
jest.mock("../../capabilities/windowsProvider", () => ({
  hostWindows: {
    broadcast: (channel: string, payload: unknown) => {
      broadcasts.push([channel, payload]);
      order.push(`broadcast ${channel}`);
    },
  },
}));
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
jest.mock("../../services/db/rcsCacheRunsDbService", () => ({
  recordRcsCacheRun: (_u: string, run: unknown) => void mockRunRecords.push(run),
  getRcsCacheRun: () => mockLastRun,
  clearRcsCacheRun: jest.fn(),
}));
jest.mock("../../utils/wrapHandler", () => ({
  wrapHandler: (fn: (event: unknown, args?: unknown) => Promise<unknown>) => fn,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const handlersModule = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");

beforeAll(() => handlersModule.registerRcsImportHandlers());

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const startCache = () => handlers.get("rcs-import:start-cache-job")!({}, undefined) as Promise<{ success: boolean; error?: string }>;
const startTx = () => handlers.get("rcs-import:start-job")!({}, { transactionId: "tx-1" }) as Promise<{ success: boolean; error?: string }>;

describe("a cache Sync being saved (SR B1, S1)", () => {
  it("busy while saving; a refresh only after the save and the auto-link", async () => {
    expect((await startCache()).success).toBe(true);
    // The job finishes: its slot is free at once; the save starts.
    bridgeOptions.onJobEnded({
      kind: "cache", userId: "user-1", detectedOwnNumber: null,
      snapshot: { state: "finished", jobId: "job-1", createdAt: "2026-10-01T10:00:00.000Z" },
    });
    expect(handlersModule.cacheSaveInFlight()).toBe(true);
    await flush();
    expect(order).toEqual(["commit"]);

    // B1: nothing that could sweep the staging or write the same files.
    const cache = await startCache();
    expect(cache).toEqual({ success: false, error: handlersModule.RCS_SAVING_MESSAGE });
    expect(await startTx()).toEqual({ success: false, error: handlersModule.RCS_SAVING_MESSAGE });
    await expect(handlersModule.clearGoogleMessagesWebTexts("user-1")).rejects.toThrow(handlersModule.RCS_SAVING_MESSAGE);
    expect(broadcasts).toEqual([]);

    // The save finishes: auto-link, then the refresh (S1); no longer busy.
    releaseCommit?.();
    await flush();
    expect(order).toEqual(["commit", "autolink", `broadcast ${handlersModule.RCS_DATA_CHANGED_CHANNEL}`]);
    expect(handlersModule.cacheSaveInFlight()).toBe(false);
    expect((await startTx()).error).not.toBe(handlersModule.RCS_SAVING_MESSAGE);
    expect((await startCache()).success).toBe(true);
  });

  it("a hung save releases the busy flag after the timeout and drops that job's staging (T1)", async () => {
    jest.useFakeTimers();
    try {
      bridgeOptions.onJobEnded({
        kind: "cache", userId: "user-1", detectedOwnNumber: null,
        snapshot: { state: "finished", jobId: "job-1", createdAt: "2026-10-01T10:00:00.000Z" },
      });
      await flush();
      expect(handlersModule.cacheSaveInFlight()).toBe(true);
      jest.advanceTimersByTime(handlersModule.RCS_CACHE_SAVE_TIMEOUT_MS - 1000);
      expect(handlersModule.cacheSaveInFlight()).toBe(true);
      jest.advanceTimersByTime(2000);
      expect(handlersModule.cacheSaveInFlight()).toBe(false);
      expect(abandoned).toEqual(["job-1"]);
      // The hung save settling later does not make the counter go negative.
      releaseCommit?.();
      await flush();
      expect(handlersModule.cacheSaveInFlight()).toBe(false);
      expect((await startCache()).success).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  // Founder (2026-10-01): the done screens show what was SAVED. Mutation: the
  // commit's result not passed to bridge.recordCacheSaved → red.
  it("saved counts: the commit's result goes to the bridge for the done screens (H4)", async () => {
    savedRecords.length = 0;
    expect((await startCache()).success).toBe(true);
    bridgeOptions.onJobEnded({
      kind: "cache", userId: "user-1", detectedOwnNumber: null,
      snapshot: { state: "finished", jobId: "job-1", createdAt: "2026-10-01T10:00:00.000Z" },
    });
    await flush();
    expect(savedRecords).toEqual([]);
    releaseCommit?.();
    await flush();
    expect(savedRecords[0]).toEqual(["job-1", { chats: 1, messages: 1, newMessages: 1 }]);
  });

  // Founder (2026-10-01): done or failed → Keepr comes to the front by itself
  // (the /focus mechanism, incl. the taskbar flash); never on a cancel.
  it.each([
    ["finished", "cache", 1],
    ["failed", "cache", 1],
    ["finished", "transaction", 1],
    ["failed", "transaction", 1],
    ["cancelled", "cache", 0],
    ["cancelled", "transaction", 0],
  ] as const)("comes to the front: %s %s job → %i (F1)", async (state, kind, times) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const front = require("../../utils/bringAppToFront") as { bringAppToFrontOrFlash: jest.Mock };
    front.bringAppToFrontOrFlash.mockClear();
    bridgeOptions.onJobEnded({
      kind, userId: "user-1", detectedOwnNumber: null,
      snapshot: { state, jobId: "job-1", createdAt: "2026-10-01T10:00:00.000Z" },
    });
    expect(front.bringAppToFrontOrFlash).toHaveBeenCalledTimes(times);
    releaseCommit?.();
    await flush();
  });

  // BACKLOG-3663: Google Messages coverage — in the commit transaction, down
  // to the floor only for a full run that checked every chat.
  // L2: a normal list stop is required; not-settled chats are counted, not blocking.
  // Mutations: not-settled blocking again, the list stop ignored, or the
  // count not recorded → red.
  it.each([
    ["a full read of every chat", 0, "since", [], "2026-07-01T00:00:00.000Z", 0],
    ["a run over the 300-chat cap", 5, "since", [], null, 0],
    ["a list scan that timed out", 0, "max_time", [], null, 0],
    ["two chats not settled (counted, not blocking)", 0, "stable",
      [{ name: "A", reason: "history_not_settled" }, { name: "B", reason: "history_not_settled" }], "2026-07-01T00:00:00.000Z", 2],
    ["a truncated chat (blocking)", 0, "since", [{ name: "A", reason: "history_truncated" }], null, 0],
  ] as const)("coverage: %s", async (_label, notChecked, listStop, notReached, expected, notSettled) => {
    coverageWrites.length = 0;
    mockRunRecords.length = 0;
    expect((await startCache()).success).toBe(true);
    bridgeOptions.onJobEnded({
      kind: "cache", userId: "user-1", detectedOwnNumber: null,
      snapshot: { state: "finished", jobId: "job-1", createdAt: "2026-10-01T10:00:00.000Z", progress: { notChecked }, notReached, listStop },
    });
    await flush();
    releaseCommit?.();
    await flush();
    expect(coverageWrites).toEqual([["user-1", "google_messages", expected]]);
    expect(mockRunRecords).toEqual([expect.objectContaining({ listStop, reachedFloor: expected !== null, notSettledChats: notSettled, fullRead: true })]);
  });
});
