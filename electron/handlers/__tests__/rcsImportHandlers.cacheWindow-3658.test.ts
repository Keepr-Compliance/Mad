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
/** The options Keepr built its bridge with (its onHello). */
let mockBridgeOptions: { onHello?: (h: { version?: string; paired?: boolean }) => void } | null = null;
const mockLogInfo = jest.fn().mockResolvedValue(undefined);
const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>();
const created: Array<{ userId: string; since: string }> = [];
let mockLastFinished: string | null = null;
let mockMediaPending = false;
const electronApp = { isPackaged: true, getPath: () => "/tmp/keepr-test" };
let planStart: string | null = "2026-07-01T00:00:00.000Z";
let mockConsentVersion: number | null = 1;
const mockSetConsent = jest.fn();

// 3671 P3: the per-chat records (mocked: this suite has no SQL).
const mockFailedRuns: Array<[string, string]> = [];
let mockFailedRunStart: string | null = null;
jest.mock("../../services/db/rcsChatCoverageDbService", () => ({
  chatDoneInFailedRun: () => false,
  clearChatCoverage: jest.fn(),
  clearChatReads: jest.fn(),
  clearFailedRun: jest.fn(),
  dealChatStarts: () => new Map(),
  dealStartForChat: () => null,
  getChatCoverage: () => new Map(),
  getChatRead: () => null,
  getFailedRun: () => mockFailedRunStart,
  latestConversationIds: () => new Map(),
  recordChatCoverage: jest.fn(),
  recordChatRead: jest.fn(),
  setFailedRun: (u: string, at: string) => void mockFailedRuns.push([u, at]),
}));
jest.mock("electron", () => ({
  app: electronApp,
  ipcMain: { handle: (channel: string, fn: (event: unknown, args?: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
  shell: { openExternal: jest.fn(async () => undefined) },
}));
jest.mock("../../services/rcsExtensionBridge", () => ({
  RcsExtensionBridge: class {
    constructor(options: unknown) {
      mockBridgeOptions = options as typeof mockBridgeOptions;
    }
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
    updateRcsCacheState: () => undefined,
    getRcsCacheState: () => ({ optedInAt: "2026-09-01T00:00:00.000Z", lastCacheFinishedAt: mockLastFinished, ownNumber: null }),
    getRcsConsent: () => ({ consentAt: "2026-09-01T00:00:00.000Z", consentVersion: mockConsentVersion, contactsOnly: false, autoDeleteDays: null }),
    rcsStagingDbOps: () => ({ deleteAll: () => undefined, journalRows: () => [], jobs: () => [], putJob: () => undefined, putChatMeta: () => undefined }),
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
  return { __esModule: true, default: { info: (...a: unknown[]) => mockLogInfo(...a), warn: noop, error: noop, debug: noop } };
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
  recordSourceCoverage: (...a: unknown[]) => void mockCoverageWrites.push(a),
  forgetSourceCoverage: jest.fn(),
}));
// BACKLOG-3785: the recorded Google Messages coverage, read directly.
jest.mock("../../services/db/rcsSourcePresenceDb", () => ({
  recordedCoveredSince: (_u: string, source: string) => (source === "google_messages" ? mockCoveredSince : null),
  hasCompanionTexts: () => false,
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

// Founder (2026-10-04): Keepr's own "Try again" for a failed Google Messages
// Sync — the page's /cache/retry semantics: only after a failed Sync; the
// Messages tab is opened for the new job as Sync does. Mutations: the
// failed-run check removed → red; no Messages tab → red.
describe("rcs-import:retry-cache-job (Keepr's Try again)", () => {
  const retry = () => handlers.get("rcs-import:retry-cache-job")!({}) as Promise<{ success: boolean; error?: string; job?: { jobId: string } }>;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shell } = require("electron") as { shell: { openExternal: jest.Mock } };

  it("no failed Sync: refused, no job, no tab", async () => {
    mockFailedRunStart = null;
    shell.openExternal.mockClear();
    const r = await retry();
    expect(r).toEqual({ success: false, error: "There is no failed Sync to try again." });
    expect(created).toHaveLength(0);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  // Storyboard H03: the page says "skipping saved chats" on a Try again run —
  // Keepr marks the job (retrying) when the user's last Sync failed.
  // Mutation: retrying not passed → red.
  it("a Sync after a failed one is marked retrying; a normal one is not", async () => {
    mockFailedRunStart = "2026-10-03T10:00:00.000Z";
    await retry();
    expect((mockLastCacheOptions as { retrying?: boolean }).retrying).toBe(true);
    mockFailedRunStart = null;
    created.length = 0;
    await start();
    expect((mockLastCacheOptions as { retrying?: boolean }).retrying).toBe(false);
  });

  it("after a failed Sync: a new cache job, and Messages opened for it", async () => {
    mockFailedRunStart = "2026-10-03T10:00:00.000Z";
    shell.openExternal.mockClear();
    const r = await retry();
    mockFailedRunStart = null;
    expect(r.success).toBe(true);
    expect(created).toHaveLength(1);
    expect(shell.openExternal).toHaveBeenCalledWith(expect.stringMatching(/#keepr-job=job-1$/));
  });
});

describe("rcs-import:start-cache-job window (BACKLOG-3658)", () => {
  // BACKLOG-3666: no Sync until the extension is paired. Mutation: the check removed → red.
  it("not paired: the Sync is refused (not_paired), no job created", async () => {
    mockPaired = false;
    const r = (await start()) as { success: boolean; error?: string };
    mockPaired = true;
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/Not linked. Click the Keepr icon/);
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

  // SR C7 (founder, 2026-10-04): consent is required (RCS_CONSENT_REQUIRED
  // true) — no current consent, no Sync, nothing recorded by the start; the
  // modal's [Agree and sync] records it first. Mutation: the gate off → red.
  it("no consent yet: the Sync is refused (consent_needed) and nothing is recorded (K6)", async () => {
    mockConsentVersion = null;
    const r = (await start()) as { success: boolean; error?: string };
    expect(r.success).toBe(false);
    expect(r.error).toBe("Agree in Keepr first: Dashboard → Sync Android.");
    expect(created).toHaveLength(0);
    expect(mockSetConsent).not.toHaveBeenCalled();
  });

  // SR (C7 review) F1: no screen-less consent shortcut in any build — the
  // P1 "set-cache-opt-in" channel is gone; consent goes only through
  // set-cache-consent, which refuses an out-of-date version.
  // Mutation: the shortcut registered again → red.
  it("no consent shortcut: set-cache-opt-in is not registered; an old version is refused", async () => {
    expect(handlers.has("rcs-import:set-cache-opt-in")).toBe(false);
    const stale = (await handlers.get("rcs-import:set-cache-consent")!({}, { version: 0 })) as { success: boolean };
    expect(stale.success).toBe(false);
    expect(mockSetConsent).not.toHaveBeenCalled();
  });

  it("a current consent is not re-recorded (K7)", async () => {
    expect((await start()).success).toBe(true);
    expect(mockSetConsent).not.toHaveBeenCalled();
  });

  // Item 5: the Sync screen's line names the months the cache floor reads
  // (messageImport.filters). Mutation: another key / no default → red.
  // Live (B1): a pairing row alone is NOT "linked" — the extension must have
  // proved it (a signed call). Mutation: extensionPaired from the row → red.
  // Live (founder): which version the extension reports, logged when it
  // changes (version only) — so "update ready" can be checked from the log.
  // Mutation: no log line, or one per hello → red.
  // Live (founder): the link screen's "Open Google Messages" opens Messages
  // with #keepr-link (the extension moves to the open tab and opens its link
  // window). Mutation: the plain URL → red.
  // Founder: link-state says whether the box fills itself here (main's one
  // platform rule). Mutation: the field missing → red.
  // Founder (2026-10-06): the ticket's Google Messages section — local state
  // only, exactly these keys (no step log, chat data, codes or keys); the last
  // ended run's state and code. Mutations: an extra key; the run not kept → red.
  it("googleMessagesDiagnostics: the allowed keys only; the last run's state and code", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");
    mockBridgeOptions!.onHello!({ version: "0.3.88" });
    (mockBridgeOptions as unknown as { onJobEnded: (e: unknown) => void }).onJobEnded({
      kind: "other", userId: null, snapshot: { state: "failed", jobId: "j-1", error: { code: "phone_unreachable", message: "Keepr stopped: …" } }, detectedOwnNumber: null,
    });
    const d = mod.googleMessagesDiagnostics("user-1");
    expect(Object.keys(d).sort()).toEqual(["extension_seen_at", "extension_version_seen", "failed_run_started_at", "last_cache_finished_at", "last_run", "link"]);
    expect(d.extension_version_seen).toBe("0.3.88");
    expect(d.last_run).toMatchObject({ state: "failed", reason_code: "phone_unreachable" });
    expect(JSON.stringify(d)).not.toMatch(/Keepr stopped/);
    expect(["linked", "saved", "none"]).toContain(d.link);
    expect(mod.googleMessagesDiagnostics(null).link).toBe("none");
    // SR: a code that is not ^[a-z_]{1,40}$ is "other". Mutation: passed through → red.
    (mockBridgeOptions as unknown as { onJobEnded: (e: unknown) => void }).onJobEnded({
      kind: "other", userId: null, snapshot: { state: "failed", jobId: "j-2", error: { code: "Not A Code 42", message: "x" } }, detectedOwnNumber: null,
    });
    expect(mod.googleMessagesDiagnostics("user-1").last_run).toMatchObject({ reason_code: "other" });
  });

  it("link-state: clipboardFill follows the platform rule", async () => {
    const r = (await handlers.get("rcs-import:link-state")!({})) as { clipboardFill?: boolean };
    expect(r.clipboardFill).toBe(process.platform === "win32");
  });

  it("Open Google Messages: the Messages URL with #keepr-link", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require("electron") as { shell: { openExternal: jest.Mock } };
    shell.openExternal.mockClear();
    await handlers.get("rcs-import:open-google-messages")!({});
    expect(shell.openExternal).toHaveBeenCalledWith("https://messages.google.com/web/conversations#keepr-link");
  });

  it("the extension's reported version is logged once per change (version only)", async () => {
    mockLogInfo.mockClear();
    mockBridgeOptions!.onHello!({ version: "0.3.85" });
    mockBridgeOptions!.onHello!({ version: "0.3.85", paired: true });
    mockBridgeOptions!.onHello!({ version: "0.3.86" });
    await new Promise((r) => setTimeout(r, 0));
    const lines = mockLogInfo.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Extension reports"));
    expect(lines).toEqual(["[RcsImport] Extension reports 0.3.85", "[RcsImport] Extension reports 0.3.86"]);
  });

  it("get-extension-state: a row nobody proved is not 'linked'", async () => {
    mockPaired = true;
    const r = (await handlers.get("rcs-import:get-extension-state")!({})) as { state: { extensionPaired?: boolean } };
    expect(r.state.extensionPaired).toBe(false);
  });

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

// Founder (2026-10-04): the auto-delete switch is removed "for now"; the
// purge is dormant — even a stored ON value (90 days) never runs it.
// Mutation: RCS_AUTO_DELETE_ENABLED back on (or the cutoff ignoring it) → red.
describe("auto-delete (BACKLOG-3658 P3b) is dormant", () => {
  const { autoDeleteCutoff, RCS_AUTO_DELETE_ENABLED } = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");
  it("a stored 90 days: no cutoff, so no purge", () => {
    expect(RCS_AUTO_DELETE_ENABLED).toBe(false);
    expect(autoDeleteCutoff(90, Date.UTC(2026, 9, 4))).toBeNull();
    expect(autoDeleteCutoff(null, Date.UTC(2026, 9, 4))).toBeNull();
  });
});
