/**
 * @jest-environment node
 */
/**
 * BACKLOG-3658 — `rcs-import:start-cache-job` takes its window from the user's
 * message import settings (the import plan), and honours the DEV-ONLY
 * `{ sinceDays }` override only when the build is NOT packaged.
 *
 * Mutation controls (each turns a test red):
 *   H1 the override honoured in a packaged build (isPackaged not passed)  → "packaged: ignored"
 *   H2 the override dropped in a dev build (args not passed through)      → "dev build: honoured"
 *   H3 the window not taken from the import plan (fixed 60 days)          → "the months setting"
 */

const DAY = 24 * 60 * 60 * 1000;
export {};

let mockLastCacheOptions: unknown = null;
const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>();
const created: Array<{ userId: string; since: string }> = [];
let mockLastFinished: string | null = null;
let mockMediaPending = false;
const electronApp = { isPackaged: true, getPath: () => "/tmp/keepr-test" };
let planStart: string | null = "2026-07-01T00:00:00.000Z";
let mockConsentVersion: number | null = 1;
const mockSetConsent = jest.fn();

jest.mock("electron", () => ({
  app: electronApp,
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
    createCacheJob(userId: string, options: { since: string }) {
      mockLastCacheOptions = options;
      created.push({ userId, since: options.since });
      return { jobId: `job-${created.length}`, kind: "cache", state: "created" };
    }
  },
}));
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    getRcsCacheState: () => ({ optedInAt: "2026-09-01T00:00:00.000Z", lastCacheFinishedAt: mockLastFinished, ownNumber: null }),
    getRcsConsent: () => ({ consentAt: "2026-09-01T00:00:00.000Z", consentVersion: mockConsentVersion, contactsOnly: false, autoDeleteDays: null }),
    rcsStagingDbOps: () => ({ deleteAll: () => undefined, journalRows: () => [] }),
    setRcsConsent: (...a: unknown[]) => mockSetConsent(...a),
  },
}));
let mockStoredFilters: Record<string, unknown> | null = null;
jest.mock("../../services/importPlanInputs", () => ({
  resolveImportPlanForUser: async () => ({ fetchStartISO: planStart, effectiveCap: 50000, protectedSpans: [] }),
  loadStoredImportFilters: async () => mockStoredFilters,
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
let mockCoveredSince: string | null = null;
const mockCoverageWrites: unknown[][] = [];
jest.mock("../../services/auditCoverageService", () => ({
  getSourceCoverage: () => (mockCoveredSince ? [{ source: "google_messages", coveredSince: mockCoveredSince }] : []),
  recordSourceCoverage: (...a: unknown[]) => void mockCoverageWrites.push(a),
  forgetSourceCoverage: jest.fn(),
}));
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
jest.mock("../../services/db/rcsMediaDbService", () => ({
  RCS_MEDIA_DEFAULTS: { photosAllChats: true, videosAllChats: false, lastPhotosSeen: null, lastVideosSeen: null },
  getRcsMediaOptions: () => ({ photosAllChats: true, videosAllChats: false, lastPhotosSeen: null, lastVideosSeen: null }),
  hasPendingMediaRead: () => mockMediaPending,
  clearPendingMediaRead: jest.fn(),
  recordRcsMediaSeen: jest.fn(),
  setRcsMediaOptions: jest.fn(),
}));
// BACKLOG-3666: paired unless a test says otherwise.
let mockPaired = true;
jest.mock("../../services/db/rcsPairingDbService", () => ({
  rcsPairingStore: { get: () => null, save: jest.fn(), existsForUser: () => mockPaired, deleteForUser: jest.fn() },
}));
jest.mock("../../utils/wrapHandler", () => ({
  wrapHandler: (fn: (event: unknown, args?: unknown) => Promise<unknown>) => fn,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registerRcsImportHandlers } = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");

beforeAll(() => registerRcsImportHandlers());
beforeEach(() => {
  created.length = 0;
  planStart = "2026-07-01T00:00:00.000Z";
  mockLastFinished = null;
  mockMediaPending = false;
  mockConsentVersion = 1;
  mockSetConsent.mockClear();
});

const start = (args?: unknown) => handlers.get("rcs-import:start-cache-job")!({}, args) as Promise<{ success: boolean }>;

describe("rcs-import:start-cache-job window (BACKLOG-3658)", () => {
  // BACKLOG-3666: no Sync until the extension is paired. Mutation: the check removed → red.
  it("not paired: the Sync is refused (not_paired), no job created", async () => {
    mockPaired = false;
    const r = (await start()) as { success: boolean; error?: string };
    mockPaired = true;
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/Pair the extension with Keepr/);
    expect(created).toHaveLength(0);
  });

  // SR M: a media toggle switched ON → the next Sync reads every chat down to
  // the floor (existing chats get their media). Mutation: the pending media
  // read ignored → the incremental since → red.
  it("a pending media read: since = the floor, not the incremental since", async () => {
    electronApp.isPackaged = true;
    mockLastFinished = "2026-09-29T10:00:00.000Z";
    expect((await start()).success).toBe(true);
    expect(created[0].since).not.toBe("2026-07-01T00:00:00.000Z"); // incremental without it
    created.length = 0;
    mockMediaPending = true;
    expect((await start()).success).toBe(true);
    expect(created[0].since).toBe("2026-07-01T00:00:00.000Z");
  });


  it("the months setting: since = the import plan's start (H3)", async () => {
    electronApp.isPackaged = true;
    expect((await start()).success).toBe(true);
    expect(created[0]).toEqual({ userId: "user-1", since: "2026-07-01T00:00:00.000Z" });
  });

  // Founder, 2026-10-01: no consent screen (RCS_CONSENT_REQUIRED false). The
  // first Sync starts and records consent_at + the version for audit.
  // Mutation: the record not written by the start → red.
  it("no consent yet: the Sync starts and records the current version (K6)", async () => {
    mockConsentVersion = null;
    const r = (await start()) as { success: boolean; error?: string };
    expect(r.success).toBe(true);
    expect(created).toHaveLength(1);
    expect(mockSetConsent).toHaveBeenCalledTimes(1);
    expect(mockSetConsent).toHaveBeenCalledWith("user-1", 1, expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });

  it("a current consent is not re-recorded (K7)", async () => {
    expect((await start()).success).toBe(true);
    expect(mockSetConsent).not.toHaveBeenCalled();
  });

  // Item 5: the Sync screen's line names the months the cache floor reads
  // (messageImport.filters). Mutation: another key / no default → red.
  it("get-extension-state: lookbackMonths from messageImport.filters (absent → 1.5, null → All time)", async () => {
    const state = async () =>
      ((await handlers.get("rcs-import:get-extension-state")!({})) as { state: { lookbackMonths?: number | null } }).state.lookbackMonths;
    mockStoredFilters = null;
    expect(await state()).toBe(1.5);
    mockStoredFilters = { lookbackMonths: 12 };
    expect(await state()).toBe(12);
    mockStoredFilters = { lookbackMonths: null };
    expect(await state()).toBeNull();
    mockStoredFilters = null;
  });

  // L2: no coverage yet → backfilled from the previous run only when it was a
  // full read with a normal list stop that reached its floor. Mutation:
  // backfill skipped, or taken from a timed-out run → red.
  it("coverage backfill: from the previous normal full run only (L2)", async () => {
    electronApp.isPackaged = true;
    mockCoverageWrites.length = 0;
    mockLastRun = { floorISO: "2026-06-01T00:00:00.000Z", fullRead: true, listStop: "stable", reachedFloor: true, notSettledChats: 0, finishedAt: "2026-09-30T00:00:00.000Z" };
    expect((await start()).success).toBe(true);
    expect(mockCoverageWrites).toEqual([["user-1", "google_messages", "2026-06-01T00:00:00.000Z", expect.any(String)]]);
    mockCoverageWrites.length = 0;
    mockLastRun = { floorISO: "2026-06-01T00:00:00.000Z", fullRead: true, listStop: "max_time", reachedFloor: true, notSettledChats: 0, finishedAt: "2026-09-30T00:00:00.000Z" };
    expect((await start()).success).toBe(true);
    expect(mockCoverageWrites).toEqual([]);
    mockLastRun = null;
  });

  // Live (0.3.15): chats switched back on go to the page with the full floor.
  // Mutation: the pending ids not passed → red.
  it("chats switched back on are handed to the cache job with the full floor", async () => {
    electronApp.isPackaged = true;
    mockPendingFull = ["conv-on-again"];
    expect((await start()).success).toBe(true);
    expect(mockLastCacheOptions).toMatchObject({ pendingConversationIds: ["conv-on-again"], floorISO: "2026-07-01T00:00:00.000Z" });
    mockPendingFull = [];
  });

  it("packaged: { sinceDays } is ignored (H1)", async () => {
    electronApp.isPackaged = true;
    expect((await start({ sinceDays: 400 })).success).toBe(true);
    expect(created[0].since).toBe("2026-07-01T00:00:00.000Z");
  });

  it("dev build: { sinceDays } is honoured, clamped to 1..3650 (H2)", async () => {
    electronApp.isPackaged = false;
    const before = Date.now();
    expect((await start({ sinceDays: 99999 })).success).toBe(true);
    const since = Date.parse(created[0].since);
    expect(since).toBeLessThanOrEqual(before - 3650 * DAY + 1000);
    expect(since).toBeGreaterThanOrEqual(before - 3650 * DAY - 60_000);
    electronApp.isPackaged = true;
  });
});

// SR M: photos / videos kept — a transaction contact, or the "all chats" toggle.
// Mutation: the toggle ignored, or a contact chat not kept → red.
describe("mediaKeptFor (SR M)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mediaKeptFor } = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");
  it("a contact chat keeps both; otherwise the toggles decide; no options → the defaults", () => {
    expect(mediaKeptFor({ photosAllChats: false, videosAllChats: false }, true)).toEqual({ photos: true, videos: true });
    expect(mediaKeptFor({ photosAllChats: true, videosAllChats: false }, false)).toEqual({ photos: true, videos: false });
    expect(mediaKeptFor({ photosAllChats: false, videosAllChats: true }, false)).toEqual({ photos: false, videos: true });
    expect(mediaKeptFor(undefined, false)).toEqual({ photos: true, videos: false });
  });
});
