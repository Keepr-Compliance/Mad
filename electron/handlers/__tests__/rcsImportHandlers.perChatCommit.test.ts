/**
 * @jest-environment node
 */
/**
 * 3671 P3 (founder, SR 2026-10-03) — per-chat commits, handler level, REAL SQL
 * (run under Electron's Node).
 *
 * Mutations that turn this red:
 *   P1 crash-left staging of ANOTHER user committed            → "a crash-left run of another user is discarded"
 *   P2 crash-left staging older than 7 days committed          → "a crash-left run of another user is discarded"
 *   F1 nobody signed in discarding the run                     → "nobody signed in (yet)"
 *   F2 a stopped run recovered from its leftover rows          → "a stopped run is never recovered"
 *   F3 overlapping recoveries settling one run twice           → "overlapping recoveries"
 *   P3 a fresh crash-left run of this user discarded            → "a crash-left run of the signed-in user"
 *   P4 Force re-import keeping staging or the journal          → "Force re-import drops every staged run"
 *   P5 exclusions not re-checked at commit                      → "a chat switched to Don't sync since"
 *   P6 "Try again" re-reading a finished chat / skipping a partial one → "Try again skips"
 *   P7 a failed run recording source coverage / no failed-run marker → "a failed run keeps its finished chats"
 *   P8 a complete run leaving the failed-run marker             → "a complete run clears"
 */

import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => require("os").tmpdir(), getAppPath: () => require("os").tmpdir() },
  ipcMain: { handle: jest.fn() },
  shell: { openExternal: jest.fn() },
  clipboard: { writeText: jest.fn() },
}));
const mockLogInfo = jest.fn().mockResolvedValue(undefined);
jest.mock("../../services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: (...a: unknown[]) => mockLogInfo(...a), warn: noop, error: noop, debug: noop } };
});
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));
jest.mock("../../capabilities/windowsProvider", () => ({ hostWindows: { broadcast: jest.fn() } }));
jest.mock("../../windowRegistry", () => ({ getMainWindow: () => null }));
jest.mock("../../utils/bringAppToFront", () => ({ bringAppToFront: jest.fn(), bringAppToFrontOrFlash: jest.fn() }));
jest.mock("../../services/autoLinkService", () => ({ autoLinkNewMessagesForUser: jest.fn() }));
jest.mock("../../services/sessionService", () => ({ __esModule: true, default: { loadSession: async () => null } }));

import { setDb } from "../../services/db/core/dbConnection";
import { peopleFrom, rcsChatHash, type RcsIncomingChat } from "../../services/rcsImportStore";
import { getChatRead, getFailedRun, setFailedRun } from "../../services/db/rcsChatCoverageDbService";
import { getSourceCoverage } from "../../services/auditCoverageService";

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  commitCacheStaging, recoverLeftoverStaging, resetGoogleMessagesCacheRecords, noteCacheChatRead, trackCacheChats,
  takeCacheChats, cacheChatSkipFor, cacheChatFloorFor, RCS_LEFTOVER_STAGING_MAX_AGE_MS,
} = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");
/* eslint-enable @typescript-eslint/no-require-imports */
import { RcsCacheStaging } from "../../services/rcsCacheStaging";
import { rcsStagingDbOps } from "../../services/db/syncDbService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-p3";
const OTHER = "user-p3-other";
const JOB_BASE = "41111111-2222-4333-8444-5555555555"; // pii-allow-uuid: invented, not from any live row
let jobN = 10;
let JOB = "";
const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const FLOOR_ISO = "2026-08-15T00:00:00.000Z";
const LIMITS = { floorMs: Date.parse(FLOOR_ISO), cap: null, protectedSpans: [] };
const READ = { fullRead: true, floorISO: FLOOR_ISO };
const NUM_A = "+15555550111";
const NUM_B = "+15555550112";
const pplA = peopleFrom([{ name: "Test Contact A", number: NUM_A }], [NUM_A]);
const pplB = peopleFrom([{ name: "Test Contact B", number: NUM_B }], [NUM_B]);
const HASH_A = rcsChatHash(pplA.numbers);
const HASH_B = rcsChatHash(pplB.numbers);

let db: DatabaseType;
/** A staging object on the same database (the handler's own is used by the code under test). */
let staging: RcsCacheStaging;

function chat(conversationId: string): RcsIncomingChat {
  return {
    conversationId,
    title: "x",
    messages: [{ msgId: "m1", direction: "inbound", sender: "x", text: "hello", sentAt: "2026-09-20T10:00:00.000Z", transport: "rcs" }],
  };
}

const count = (q: string, ...p: unknown[]) => (db.prepare(q).get(...p) as { n: number }).n;
const threadRows = (hash: string) => count("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?", `gmweb2-${hash}`);

/** A run as the job leaves it: its record, two staged chats and what the page said of each. */
function stageRun(userId: string, startedAt: string, reached: { a: boolean; b: boolean }): void {
  trackCacheChats(JOB, { settingsFloorMs: LIMITS.floorMs, fullRead: true, devOverride: false, pendingIds: [], sourceCoveredSince: null });
  staging.beginJob(JOB, { userId, startedAt, limitsJson: JSON.stringify(LIMITS), readJson: JSON.stringify(READ) });
  cacheChatFloorFor(JOB, userId, "conv-a", pplA.numbers);
  cacheChatFloorFor(JOB, userId, "conv-b", pplB.numbers);
  staging.stageChat(JOB, userId, chat("conv-a"), pplA, HASH_A);
  noteCacheChatRead(JOB, pplA.numbers, reached.a, NOW - 60_000);
  staging.stageChat(JOB, userId, chat("conv-b"), pplB, HASH_B);
  noteCacheChatRead(JOB, pplB.numbers, reached.b, NOW - 30_000);
  takeCacheChats(JOB);
}

beforeEach(() => {
  jobN += 1;
  JOB = JOB_BASE + String(jobN);
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  for (const [id, n] of [[USER, 1], [OTHER, 2]] as const) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(id, `agent-p3-${n}@example.test`, `oauth-p3-${n}`);
  }
  setDb(db);
  staging = new RcsCacheStaging(rcsStagingDbOps(), {
    stagingRoot: nodePath.join(require("os").tmpdir(), "rcs-p3-staging"),
    attachmentsDir: nodePath.join(require("os").tmpdir(), "rcs-p3-attachments"),
    mkdir: async () => undefined,
    writeSealed: async () => undefined,
    exists: async () => false,
    move: async () => undefined,
    unlink: async () => undefined,
    removeDir: async () => undefined,
    listDir: async () => [],
  });
});

afterEach(() => db?.close());

describe("3671 P3: per-chat commits (SR 2026-10-03)", () => {
  it("a crash-left run of another user, or older than 7 days, is discarded — nothing saved (P1, P2)", async () => {
    stageRun(OTHER, new Date(NOW - 60_000).toISOString(), { a: true, b: true });
    expect(await recoverLeftoverStaging(USER, NOW)).toEqual({ committed: 0, discarded: 1, kept: 0 });
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM rcs_cache_staging_chats")).toBe(0);

    jobN += 1;
    JOB = JOB_BASE + String(jobN);
    stageRun(USER, new Date(NOW - RCS_LEFTOVER_STAGING_MAX_AGE_MS - 1).toISOString(), { a: true, b: true });
    expect(await recoverLeftoverStaging(USER, NOW)).toEqual({ committed: 0, discarded: 1, kept: 0 });
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(0);
  });

  // SR F1: at app start the session may not be restored yet — nobody signed
  // in must leave the run untouched (it was discarded before). Mutation: a
  // null user discarding → red.
  it("nobody signed in (yet): the run is kept untouched, then saved once its user signs in (F1)", async () => {
    stageRun(USER, new Date(NOW - 60_000).toISOString(), { a: true, b: true });
    expect(await recoverLeftoverStaging(null, NOW)).toEqual({ committed: 0, discarded: 0, kept: 1 });
    expect(count("SELECT COUNT(*) AS n FROM rcs_cache_staging_jobs")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM rcs_cache_staging_chats")).toBe(2);
    expect(await recoverLeftoverStaging(USER, NOW)).toEqual({ committed: 1, discarded: 0, kept: 0 });
    expect(threadRows(HASH_A)).toBe(1);
  });

  // SR F2: a stopped run (the user's Stop, a quit) must never be saved as a
  // crash-cut run, even if its rows are still there. Mutation: the record
  // kept on a stop → red.
  it("a stopped run is never recovered, even if its staging rows are left (F2)", async () => {
    stageRun(USER, new Date(NOW - 60_000).toISOString(), { a: true, b: true });
    staging.markStopped(JOB);
    expect(count("SELECT COUNT(*) AS n FROM rcs_cache_staging_jobs")).toBe(0);
    // The app quit before the async discard: the rows are still there.
    expect(count("SELECT COUNT(*) AS n FROM rcs_cache_staging_chats")).toBe(2);
    expect(await recoverLeftoverStaging(USER, NOW)).toEqual({ committed: 0, discarded: 0, kept: 0 });
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(0);
  });

  // SR F3: one recovery at a time. Mutation: no single flight → red (the
  // second call settles the same run again).
  it("overlapping recoveries share one run (F3)", async () => {
    stageRun(USER, new Date(NOW - 60_000).toISOString(), { a: true, b: true });
    const [first, second] = await Promise.all([recoverLeftoverStaging(USER, NOW), recoverLeftoverStaging(USER, NOW)]);
    expect(first).toEqual({ committed: 1, discarded: 0, kept: 0 });
    expect(second).toBe(first);
    expect(threadRows(HASH_A)).toBe(1);
  });

  it("a crash-left run of the signed-in user (within 7 days): its finished chats are saved as a failed run (P3)", async () => {
    const started = new Date(NOW - 5 * 60_000).toISOString();
    stageRun(USER, started, { a: true, b: false });
    expect(await recoverLeftoverStaging(USER, NOW)).toEqual({ committed: 1, discarded: 0, kept: 0 });
    expect(threadRows(HASH_A)).toBe(1);
    expect(threadRows(HASH_B)).toBe(1);
    expect(getFailedRun(USER)).toBe(started);
    expect(count("SELECT COUNT(*) AS n FROM rcs_cache_staging_jobs")).toBe(0);
  });

  it("a failed run keeps its finished chats, records each chat's read, sets the failed-run marker, no source coverage (P7)", async () => {
    const started = new Date(NOW - 5 * 60_000).toISOString();
    stageRun(USER, started, { a: true, b: false });
    const r = await commitCacheStaging(JOB, USER, LIMITS, READ, { complete: false, startedAt: started });
    expect(r.chats).toBe(2);
    expect(getChatRead(USER, HASH_A)).toEqual({ readAt: new Date(NOW - 60_000).toISOString(), reachedFloor: true });
    expect(getChatRead(USER, HASH_B)?.reachedFloor).toBe(false);
    expect(getFailedRun(USER)).toBe(started);
    expect(getSourceCoverage(USER).find((c) => c.source === "google_messages")?.coveredSince ?? null).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM rcs_cache_runs")).toBe(0); // no run record either
  });

  // Live (founder): counts only — "chat coverage recorded: N" (chats that
  // reached their floor). Mutation: not counted / not logged → red.
  it("the commit logs how many chats recorded their coverage (counts only)", async () => {
    mockLogInfo.mockClear();
    const started = new Date(NOW - 5 * 60_000).toISOString();
    stageRun(USER, started, { a: true, b: false });
    await commitCacheStaging(JOB, USER, LIMITS, READ, { complete: false, startedAt: started });
    expect(mockLogInfo.mock.calls.map((c) => String(c[0]))).toContain("[RcsCache] chat coverage recorded: 1");
  });

  it("a complete run clears the failed-run marker and records the source coverage (P8)", async () => {
    setFailedRun(USER, "2026-10-01T00:00:00.000Z");
    stageRun(USER, new Date(NOW - 60_000).toISOString(), { a: true, b: true });
    await commitCacheStaging(JOB, USER, LIMITS, READ, {
      complete: true,
      startedAt: new Date(NOW - 60_000).toISOString(),
      snapshot: { state: "finished", jobId: JOB, listStop: "since", progress: { notChecked: 0 }, notReached: [] },
    });
    expect(getFailedRun(USER)).toBeNull();
    expect(getSourceCoverage(USER).find((c) => c.source === "google_messages")?.coveredSince).toBe(FLOOR_ISO);
  });

  it("a chat switched to Don't sync since it was read is not saved (P5)", async () => {
    stageRun(USER, new Date(NOW - 60_000).toISOString(), { a: true, b: true });
    db.prepare("INSERT INTO rcs_chat_exclusions (id, user_id, chat_hash, conversation_id) VALUES ('x1', ?, ?, 'conv-b')").run(USER, HASH_B);
    const r = await commitCacheStaging(JOB, USER, LIMITS, READ, { complete: false, startedAt: new Date(NOW).toISOString() });
    expect(r).toMatchObject({ chats: 1, chatsExcluded: 1 });
    expect(threadRows(HASH_B)).toBe(0);
  });

  it("Force re-import drops every staged run and the placed-files journal, in its transaction (P4)", () => {
    stageRun(USER, new Date(NOW - 60_000).toISOString(), { a: true, b: true });
    db.prepare("INSERT INTO rcs_cache_placed_files (path, job_id) VALUES ('/x/placed.png', ?)").run(JOB);
    resetGoogleMessagesCacheRecords(USER);
    for (const t of ["rcs_cache_staging_jobs", "rcs_cache_staging_chat_meta", "rcs_cache_staging_chats", "rcs_cache_staging_messages", "rcs_cache_placed_files"]) {
      expect([t, count(`SELECT COUNT(*) AS n FROM ${t}`)]).toEqual([t, 0]);
    }
  });

  it("Try again skips a chat the failed run finished (read since its start, down to its floor); a partial one is read again (P6)", async () => {
    const failedStart = new Date(NOW - 10 * 60_000).toISOString();
    stageRun(USER, failedStart, { a: true, b: false });
    await commitCacheStaging(JOB, USER, LIMITS, READ, { complete: false, startedAt: failedStart });
    jobN += 1;
    JOB = JOB_BASE + String(jobN);
    trackCacheChats(JOB, {
      settingsFloorMs: LIMITS.floorMs, fullRead: false, devOverride: false, pendingIds: ["conv-pending"], sourceCoveredSince: null,
      tryAgainSince: getFailedRun(USER),
    });
    expect(cacheChatSkipFor(JOB, USER, "conv-a", pplA.numbers)).toBe(true);
    expect(cacheChatSkipFor(JOB, USER, "conv-b", pplB.numbers)).toBe(false); // not down to its floor
    expect(cacheChatSkipFor(JOB, USER, "conv-pending", pplA.numbers)).toBe(false); // switched back on: read in full
    takeCacheChats(JOB);
    // Not a "Try again" run: nothing is skipped.
    trackCacheChats(JOB, { settingsFloorMs: LIMITS.floorMs, fullRead: false, devOverride: false, pendingIds: [], sourceCoveredSince: null });
    expect(cacheChatSkipFor(JOB, USER, "conv-a", pplA.numbers)).toBe(false);
    takeCacheChats(JOB);
  });
});
