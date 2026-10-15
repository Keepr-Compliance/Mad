/**
 * @jest-environment node
 */
/**
 * BACKLOG-3785 — while the Google Messages setup screen is open it polls
 * `rcs-import:get-extension-state` every 3 s (GoogleMessagesSyncFlow.tsx). The
 * handler's `companionData` ran the full per-source coverage scan
 * (MESSAGES_FLOOR_BY_SOURCE_SQL: json_extract over EVERY text of the user) on the
 * main thread: ~1.9-3.7 s per poll at ~668k messages. It now reads Companion
 * presence through the thread_id index (rcsSourcePresenceDb.hasCompanionTexts),
 * and the Sync start reads the recorded Google Messages coverage row directly.
 *
 * REAL handler, REAL encrypted database built from schema.sql, real driver.
 * Size: KEEPR_3785_MESSAGES (default 20000). Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 * Under plain node the driver cannot load and the suite is skipped with a warning.
 *
 * Fixture shapes are transcribed from their producers:
 *   Companion text — localSyncService.storeMessages (channel "sms", thread_id
 *                    "android-thread-<id>", metadata.source "android_wifi_sync");
 *                    the v2.14.0 form stored thread_id "" (e1ddd5eaf).
 *   iPhone text    — iPhoneSyncStorageService.storeMessages (metadata.source "iphone_sync")
 *   Mac text       — metadata.source "macos_messages"
 *   thread_id ""   — written only by the v2.14.0 Companion writer; macOS, iPhone and
 *                    Google Messages write a prefixed id or NULL (checked 2026-10-10).
 * Reserved 555-01xx numbers only (public repo).
 *
 * Controls:
 *   C1 the scan statement is never prepared on the main connection by either
 *      handler path, and get-extension-state stays under 50 ms at this size.
 *   C2 the new statement is index-bounded (EXPLAIN QUERY PLAN: no full SCAN of messages).
 *   C3 companionData / the recorded coverage equal the old getSourceCoverage answers,
 *      handler-level on both branches and function-level on every row shape.
 *   Mutation: restore `getSourceCoverage(userId).some(...)` at the handler → C1 red.
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import { performance } from "perf_hooks";
import type { Database as DatabaseType } from "better-sqlite3";

const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>();

jest.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/tmp/keepr-3785" },
  ipcMain: { handle: (channel: string, fn: (event: unknown, args?: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
  shell: { openExternal: jest.fn(async () => undefined) },
  clipboard: { writeText: jest.fn() },
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../../services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  const m = { info: noop, warn: noop, error: noop, debug: noop };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../services/permissionService", () => ({
  __esModule: true,
  default: { checkFullDiskAccess: jest.fn().mockResolvedValue({ hasPermission: false }) },
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
    createCacheJob() {
      return { jobId: "job-1", kind: "cache", state: "created" };
    }
  },
}));
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    updateRcsCacheState: () => undefined,
    getRcsCacheState: () => ({ optedInAt: "2026-09-01T00:00:00.000Z", lastCacheFinishedAt: null, ownNumber: null }),
    getRcsConsent: () => ({ consentAt: "2026-09-01T00:00:00.000Z", consentVersion: 1, contactsOnly: false, autoDeleteDays: null }),
    rcsStagingDbOps: () => ({ deleteAll: () => undefined, journalRows: () => [], jobs: () => [], putJob: () => undefined, putChatMeta: () => undefined }),
  },
}));
jest.mock("../../services/importPlanInputs", () => ({
  resolveImportPlanForUser: async () => ({ fetchStartISO: "2026-07-01T00:00:00.000Z", effectiveCap: 50000, protectedSpans: [] }),
  loadStoredImportFilters: async () => null,
}));
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: async () => ({ user: { id: "user-3785" } }) },
}));
jest.mock("../../services/autoLinkService", () => ({ autoLinkNewMessagesForUser: jest.fn() }));
jest.mock("../../services/messageMatchingService", () => ({ createCommunicationReference: jest.fn() }));
jest.mock("../../capabilities/windowsProvider", () => ({ hostWindows: { broadcast: jest.fn() } }));
jest.mock("../../utils/bringAppToFront", () => ({ bringAppToFront: jest.fn(), bringAppToFrontOrFlash: jest.fn() }));
jest.mock("../../windowRegistry", () => ({ getMainWindow: () => null }));
jest.mock("../../services/db/rcsChatCoverageDbService", () => ({
  chatDoneInFailedRun: () => false,
  clearChatCoverage: jest.fn(),
  clearChatReads: jest.fn(),
  clearFailedRun: jest.fn(),
  dealChatStarts: () => new Map(),
  dealStartForChat: () => null,
  getChatCoverage: () => new Map(),
  getChatRead: () => null,
  getFailedRun: () => null,
  latestConversationIds: () => new Map(),
  linkedChatHashes: () => new Set(),
  recordChatCoverage: jest.fn(),
  recordChatRead: jest.fn(),
  setFailedRun: jest.fn(),
}));
jest.mock("../../services/db/rcsPendingFullSyncDbService", () => ({
  listPendingFullRead: () => [],
  clearPendingFullRead: jest.fn(),
  clearAllPendingFullRead: jest.fn(),
}));
jest.mock("../../services/db/rcsCacheRunsDbService", () => ({
  recordRcsCacheRun: jest.fn(),
  getRcsCacheRun: () => null,
  clearRcsCacheRun: jest.fn(),
}));
jest.mock("../../services/db/rcsMediaDbService", () => ({
  RCS_MEDIA_DEFAULTS: { photosAllChats: true, videosAllChats: false, lastPhotosSeen: null, lastVideosSeen: null },
  getRcsMediaOptions: () => ({ photosAllChats: true, videosAllChats: false, lastPhotosSeen: null, lastVideosSeen: null }),
  hasPendingMediaRead: () => false,
  clearPendingMediaRead: jest.fn(),
  recordRcsMediaSeen: jest.fn(),
  setRcsMediaOptions: jest.fn(),
}));
jest.mock("../../services/db/rcsPairingDbService", () => ({
  rcsPairingStore: { get: () => null, save: jest.fn(), existsForUser: () => true, deleteForUser: jest.fn() },
}));
jest.mock("../../utils/wrapHandler", () => ({
  wrapHandler: (fn: (event: unknown, args?: unknown) => Promise<unknown>) => fn,
}));

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const KEY_HEX = "3785".repeat(16);
const USER = "user-3785";
const MESSAGES = Number(process.env.KEEPR_3785_MESSAGES || 20_000);
const MAX_HANDLER_MS = 50;

function loadDriver(): (new (file: string, opts?: object) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    process.stderr.write(`[3785] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}

const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

maybe("BACKLOG-3785: Google Messages state poll never runs the coverage scan on main (real handler, encrypted DB)", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { setDb } = require("../../services/db/core/dbConnection") as typeof import("../../services/db/core/dbConnection");
  const { getSourceCoverage } = require("../../services/auditCoverageService") as typeof import("../../services/auditCoverageService");
  const { MESSAGES_FLOOR_BY_SOURCE_SQL } = require("../../services/db/auditCoverageSql") as typeof import("../../services/db/auditCoverageSql");
  const presence = require("../../services/db/rcsSourcePresenceDb") as typeof import("../../services/db/rcsSourcePresenceDb");
  const { registerRcsImportHandlers } = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");
  /* eslint-enable @typescript-eslint/no-require-imports */

  let dir: string;
  let main: DatabaseType;
  let prepared: string[] = [];
  let recording = false;
  let addMessage: import("better-sqlite3").Statement<unknown[]>;

  const oldCompanion = (u: string): boolean => getSourceCoverage(u).some((c) => c.source === "android_companion");
  const oldGoogleCoveredSince = (u: string): string | null =>
    getSourceCoverage(u).find((c) => c.source === "google_messages")?.coveredSince ?? null;

  function companionRow(id: string, user: string, threadId: string, extra: { reaction?: number | null; duplicateOf?: string | null } = {}): void {
    addMessage.run(
      id, user, "sms", `x-${id}`, "inbound", "hello",
      JSON.stringify({ from: "+12015550101", to: ["me"] }), "12015550101", threadId,
      "2026-03-28T10:00:00.000Z",
      JSON.stringify({ source: "android_wifi_sync", deviceId: "dev-1", androidThreadId: "7", originalSender: "+12015550101" }),
      extra.reaction ?? null, extra.duplicateOf ?? null,
    );
  }

  async function extensionState(): Promise<{ companionData?: boolean }> {
    const r = (await handlers.get("rcs-import:get-extension-state")!({})) as { state: { companionData?: boolean } };
    return r.state;
  }

  beforeAll(() => {
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3785-"));
    const dbPath = nodePath.join(dir, "mad.db");
    main = new (Database as NonNullable<typeof Database>)(dbPath);
    main.pragma(`key = "x'${KEY_HEX}'"`);
    main.pragma("cipher_compatibility = 4");
    main.pragma("journal_mode = WAL");
    main.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    const users = [USER, "u-comp", "u-legacy", "u-cov", "u-filtered", "u-none", "u-gm"];
    const addUser = main.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)");
    for (const u of users) addUser.run(u, `${u}@example.test`, `oauth-${u}`);
    addMessage = main.prepare<unknown[]>(
      `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, participants_flat,
         thread_id, sent_at, metadata, associated_message_type, duplicate_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    main.transaction(() => {
      // The env-sized user: iPhone and Mac texts, 2% with no chat (thread_id NULL, as
      // iPhoneSyncStorageService `threadId || null` and the macOS importer write it) — no
      // Companion text. No producer but the v2.14.0 Companion writer stores "".
      for (let i = 0; i < MESSAGES; i++) {
        const sentAt = new Date(1_600_000_000_000 + i * 60_000).toISOString();
        const handle = `+1${200 + (i % 50)}5550${100 + (i % 100)}`;
        const mac = i % 3 === 0;
        addMessage.run(
          `m${i}`, USER, mac ? "imessage" : "sms", `g${i}`, i % 2 ? "inbound" : "outbound", `body ${i}`,
          JSON.stringify({ from: i % 2 ? handle : "me", to: i % 2 ? ["me"] : [handle] }), handle.replace(/\D/g, ""),
          i % 50 === 0 ? null : `ios-chat-${i % 300}`, sentAt,
          JSON.stringify(mac ? { source: "macos_messages" } : { source: "iphone_sync", originalId: i }),
          null, null,
        );
      }
      // Function-level shapes.
      for (let i = 0; i < 5; i++) companionRow(`comp-${i}`, "u-comp", `android-thread-${i}`);
      companionRow("legacy-1", "u-legacy", "");
      companionRow("filt-react", "u-filtered", "android-thread-1", { reaction: 2000 });
      companionRow("filt-dup", "u-filtered", "android-thread-1", { duplicateOf: "comp-0" });
      addMessage.run(
        "none-1", "u-none", "sms", "x-none-1", "inbound", "hi", JSON.stringify({ from: "+12015550102", to: ["me"] }),
        "12015550102", "ios-chat-1", "2026-03-28T10:00:00.000Z", JSON.stringify({ source: "iphone_sync" }), null, null,
      );
      main.prepare("INSERT INTO message_source_coverage (user_id, source, covered_since, last_sync_at) VALUES (?, ?, ?, ?)").run(
        "u-cov", "android_companion", null, "2026-09-01T00:00:00.000Z",
      );
      main.prepare("INSERT INTO message_source_coverage (user_id, source, covered_since, last_sync_at) VALUES (?, ?, ?, ?)").run(
        "u-gm", "google_messages", "2026-05-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z",
      );
    })();

    const realPrepare = main.prepare.bind(main);
    (main as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
      if (recording) prepared.push(s);
      return realPrepare(s);
    };
    setDb(main);
    registerRcsImportHandlers();
  }, 600_000);

  beforeEach(() => {
    prepared = [];
    recording = false;
  });

  afterAll(() => {
    main?.close();
    nodeFs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("C1: get-extension-state never prepares the coverage scan on main, and stays under 50 ms", async () => {
    await extensionState(); // first call: the bundled extension version read
    const times: number[] = [];
    recording = true;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await extensionState();
      times.push(performance.now() - t0);
    }
    recording = false;
    expect(prepared.length).toBeGreaterThan(0); // the recorder sees this handler's statements
    expect(prepared).not.toContain(MESSAGES_FLOOR_BY_SOURCE_SQL);
    const worst = Math.max(...times);
    // The old read, timed where it used to run (printed, not asserted).
    const t0 = performance.now();
    oldCompanion(USER);
    const oldMs = performance.now() - t0;
    process.stderr.write(
      `[3785] get-extension-state over ${MESSAGES} msgs: worst=${worst.toFixed(1)}ms (old scan alone ${oldMs.toFixed(1)}ms)\n`,
    );
    expect(worst).toBeLessThan(MAX_HANDLER_MS);
  }, 120_000);

  it("C1: Sync start never prepares the coverage scan on main", async () => {
    recording = true;
    const r = (await handlers.get("rcs-import:start-cache-job")!({})) as { success: boolean };
    recording = false;
    expect(r.success).toBe(true);
    expect(prepared).toContain(presence.RECORDED_COVERED_SINCE_SQL);
    expect(prepared).not.toContain(MESSAGES_FLOOR_BY_SOURCE_SQL);
  }, 120_000);

  it("C2: the Companion presence read is index-bounded (no full scan of messages)", () => {
    const plan = (main.prepare(`EXPLAIN QUERY PLAN ${presence.COMPANION_TEXTS_EXIST_SQL}`).all(USER, USER, USER) as Array<{ detail: string }>).map(
      (r) => r.detail,
    );
    const onMessages = plan.filter((d) => / m\b| messages\b/.test(d));
    expect(onMessages.length).toBeGreaterThanOrEqual(2);
    // BACKLOG-3884: idx_messages_thread_sent (thread_id, sent_at) is a thread index too;
    // the planner may pick either. What is pinned is an index search by thread_id.
    for (const d of onMessages) expect(d).toMatch(/^SEARCH .*USING INDEX idx_messages_thread_(id|sent) \(thread_id/);
    expect(plan.some((d) => /^SCAN (m|messages)\b/.test(d))).toBe(false);
  });

  it("C3: handler companionData equals the old answer on both branches (none, then one Companion text)", async () => {
    expect(oldCompanion(USER)).toBe(false);
    expect((await extensionState()).companionData).toBe(false);
    companionRow("big-comp", USER, "android-thread-42");
    try {
      expect(oldCompanion(USER)).toBe(true);
      expect((await extensionState()).companionData).toBe(true);
    } finally {
      main.prepare("DELETE FROM messages WHERE id = ?").run("big-comp");
    }
    expect((await extensionState()).companionData).toBe(false);
  });

  it("C3: hasCompanionTexts equals the old answer on every row shape", () => {
    const expected: Record<string, boolean> = {
      "u-comp": true, // android-thread-* texts
      "u-legacy": true, // the v2.14.0 "" thread_id form
      "u-cov": true, // a recorded coverage row, no texts
      "u-filtered": false, // only a tapback and a duplicate
      "u-none": false, // other sources only; u-comp's texts are not theirs
      "u-gm": false,
    };
    const got: Record<string, boolean> = {};
    const old: Record<string, boolean> = {};
    for (const u of Object.keys(expected)) {
      got[u] = presence.hasCompanionTexts(u);
      old[u] = oldCompanion(u);
    }
    expect(old).toEqual(expected);
    expect(got).toEqual(old);
  });

  it("C3: recordedCoveredSince equals the old Sync-start read (row and no row)", () => {
    for (const u of ["u-gm", "u-cov", USER]) {
      expect(presence.recordedCoveredSince(u, "google_messages")).toBe(oldGoogleCoveredSince(u));
    }
    expect(presence.recordedCoveredSince("u-gm", "google_messages")).toBe("2026-05-01T00:00:00.000Z");
  });
});
