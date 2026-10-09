/**
 * @jest-environment node
 */
/**
 * SR (2026-10-02) — per-chat widening for deals, handler level, REAL SQL
 * (run under Electron's Node).
 *
 * A live deal whose audit period starts before the months setting widens
 * ONLY its own chat (read further back, kept at the commit, its own
 * coverage row); every other chat keeps the settings floor, and the source
 * coverage keeps its meaning (all chats down to the settings floor).
 *
 * Mutations that turn this red:
 *   W1 the deal floor applied to every chat (job-wide)        → "a January deal widens only its own chat"
 *   W2 a rejected deal widening                               → "a January deal widens only its own chat"
 *   W3 the commit dropping the deal chat's older messages     → "the commit keeps the January chat's older texts"
 *   W4 source coverage raised to the deal's start             → "the commit keeps the January chat's older texts"
 *   W5 per-chat coverage recorded for a chat not read down    → "a chat not read down to its floor"
 *   W6 a covered chat widened again                           → "a chat already read back"
 *   W7 the export gate not using the per-thread coverage      → "the export gate and the Texts tab"
 *   W8 a Don't-sync chat in the claim                         → "the claim names the deal chats"
 *   W9 the dev window override still widening                 → "dev window override"
 *   W10 a thread linked to a live deal not widened (v1 (a))   → "a thread linked to a live deal"
 */

import * as nodePath from "path";
import * as fs from "fs";
import * as os from "os";
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
jest.mock("../../services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));
jest.mock("../../services/permissionService", () => ({
  __esModule: true,
  default: { checkFullDiskAccess: jest.fn(async () => ({ hasPermission: false })) },
}));
jest.mock("../../capabilities/windowsProvider", () => ({ hostWindows: { broadcast: jest.fn() } }));
jest.mock("../../windowRegistry", () => ({ getMainWindow: () => null }));
jest.mock("../../utils/bringAppToFront", () => ({ bringAppToFront: jest.fn(), bringAppToFrontOrFlash: jest.fn() }));
jest.mock("../../services/autoLinkService", () => ({ autoLinkNewMessagesForUser: jest.fn() }));
jest.mock("../../services/sessionService", () => ({ __esModule: true, default: { loadSession: async () => null } }));

import { setDb } from "../../services/db/core/dbConnection";
import { rcsStagingDbOps } from "../../services/db/syncDbService";
import { RcsCacheStaging, type RcsStagingFs } from "../../services/rcsCacheStaging";
import { peopleFrom, rcsChatHash, type RcsIncomingChat } from "../../services/rcsImportStore";
import { getChatCoverage, recordChatCoverage } from "../../services/db/rcsChatCoverageDbService";
import { checkExportCompleteness, getSourceCoverage, getTransactionTextCoverage, recordSourceCoverage } from "../../services/auditCoverageService";

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  commitWriter, commitCacheStaging, cacheChatFloorFor, noteCacheChatRead, trackCacheChats, takeCacheChats, dealChatsForClaim,
} = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");
/* eslint-enable @typescript-eslint/no-require-imports */

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-widen";
const JOB_BASE = "31111111-2222-4333-8444-5555555555"; // pii-allow-uuid: invented, not from any live row
// A new job id per test: the handler's staging remembers ended jobs, as in the app.
let JOB = "";
let jobN = 10;
const SETTINGS_FLOOR_ISO = "2026-08-15T00:00:00.000Z";
const SETTINGS_FLOOR = Date.parse(SETTINGS_FLOOR_ISO);
const JANUARY_ISO = "2026-01-10T00:00:00.000Z";
const JANUARY = Date.parse(JANUARY_ISO);
const DEAL_NUM = "+15555550101";
const OTHER_NUM = "+15555550102";
const REJECTED_NUM = "+15555550103";

let db: DatabaseType;
let tmp: string;
let staging: RcsCacheStaging;

function deal(id: string, startedAt: string, status: string, phone: string): void {
  db.prepare("INSERT INTO transactions (id, user_id, property_address, started_at, status) VALUES (?, ?, ?, ?, ?)").run(
    id, USER, `${id} Example Street`, startedAt, status,
  );
  db.prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)").run(`c-${id}`, USER, `Test Contact ${id}`);
  db.prepare(
    "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary) VALUES (?, ?, ?, ?, ?, 1)",
  ).run(`p-${id}`, `c-${id}`, phone, phone, phone);
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, ?)").run(`tc-${id}`, id, `c-${id}`);
}

const pplA = peopleFrom([{ name: "Test Contact A", number: DEAL_NUM }], [DEAL_NUM]);
const pplB = peopleFrom([{ name: "Test Contact B", number: OTHER_NUM }], [OTHER_NUM]);
const HASH_A = rcsChatHash(pplA.numbers);
const HASH_B = rcsChatHash(pplB.numbers);

function chat(conversationId: string, reachedFloor: boolean): RcsIncomingChat {
  return {
    conversationId,
    title: "x",
    reachedFloor,
    messages: [
      { msgId: "old", direction: "inbound", sender: "x", text: "in February", sentAt: "2026-02-01T10:00:00.000Z", transport: "rcs" },
      { msgId: "new", direction: "inbound", sender: "x", text: "in September", sentAt: "2026-09-20T10:00:00.000Z", transport: "rcs" },
    ],
  };
}

function track(over: Partial<Parameters<typeof trackCacheChats>[1]> = {}): Map<string, number> {
  return trackCacheChats(JOB, {
    settingsFloorMs: SETTINGS_FLOOR,
    fullRead: true,
    devOverride: false,
    pendingIds: [],
    sourceCoveredSince: SETTINGS_FLOOR_ISO,
    ...over,
  });
}

const threadRows = (hash: string) =>
  (db.prepare("SELECT sent_at FROM messages WHERE user_id = ? AND thread_id = ? ORDER BY sent_at").all(USER, `gmweb2-${hash}`) as Array<{ sent_at: string }>)
    .map((r) => r.sent_at);

/** Stage both chats as the page sent them, then commit like commitCacheJob. */
async function syncBoth(reachedA: boolean, reachedB: boolean): Promise<void> {
  const chatFloors = track();
  expect(cacheChatFloorFor(JOB, USER, "conv-a", pplA.numbers)).toBe(JANUARY);
  expect(cacheChatFloorFor(JOB, USER, "conv-b", pplB.numbers)).toBeNull();
  staging.stageChat(JOB, USER, chat("conv-a", reachedA), pplA, HASH_A);
  noteCacheChatRead(JOB, pplA.numbers, reachedA);
  staging.stageChat(JOB, USER, chat("conv-b", reachedB), pplB, HASH_B);
  noteCacheChatRead(JOB, pplB.numbers, reachedB);
  const limits = { floorMs: SETTINGS_FLOOR, cap: null, protectedSpans: [], chatFloorsMs: chatFloors };
  takeCacheChats(JOB);
  // 3671 P3: chat by chat, the chat floors and reached flags from the staging.
  await commitCacheStaging(JOB, USER, limits, { fullRead: true, floorISO: SETTINGS_FLOOR_ISO }, {
    complete: true,
    startedAt: "2026-10-01T00:00:00.000Z",
    snapshot: { state: "finished", jobId: JOB, listStop: "since", progress: { notChecked: 0 }, notReached: [] },
  });
}

beforeEach(() => {
  jobN += 1;
  JOB = JOB_BASE + String(jobN);
  tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rcs-widen-"));
  const files: RcsStagingFs = {
    stagingRoot: nodePath.join(tmp, "staging"),
    attachmentsDir: nodePath.join(tmp, "attachments"),
    mkdir: async (d) => void (await fs.promises.mkdir(d, { recursive: true })),
    writeSealed: (p, data) => fs.promises.writeFile(p, data),
    exists: async (p) => fs.existsSync(p),
    move: (from, to) => fs.promises.rename(from, to),
    unlink: async (p) => void (await fs.promises.unlink(p).catch(() => undefined)),
    removeDir: async (d) => void (await fs.promises.rm(d, { recursive: true, force: true })),
    listDir: async (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []),
  };
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-widen@example.test', 'google', 'oauth-widen')").run(USER);
  setDb(db);
  staging = new RcsCacheStaging(rcsStagingDbOps(), files);
  deal("t-jan", JANUARY_ISO, "active", DEAL_NUM);
  deal("t-dead", "2025-01-01T00:00:00.000Z", "rejected", REJECTED_NUM);
});

afterEach(() => {
  takeCacheChats(JOB);
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("per-chat widening for deals (SR 2026-10-02)", () => {
  it("a January deal widens only its own chat; unrelated and rejected-deal chats keep the settings floor (W1, W2)", () => {
    track();
    expect(cacheChatFloorFor(JOB, USER, "conv-a", pplA.numbers)).toBe(JANUARY);
    expect(cacheChatFloorFor(JOB, USER, "conv-b", pplB.numbers)).toBeNull();
    expect(cacheChatFloorFor(JOB, USER, "conv-c", [REJECTED_NUM])).toBeNull();
    const t = takeCacheChats(JOB)!;
    expect(t.widened).toBe(1);
    expect(t.maxWidenDays).toBe(Math.round((SETTINGS_FLOOR - JANUARY) / 86_400_000));
  });

  it("the commit keeps the January chat's older texts, drops the unrelated chat's; source coverage stays the settings floor (W3, W4)", async () => {
    await syncBoth(true, true);
    expect(threadRows(HASH_A)).toEqual(["2026-02-01T10:00:00.000Z", "2026-09-20T10:00:00.000Z"]);
    expect(threadRows(HASH_B)).toEqual(["2026-09-20T10:00:00.000Z"]);
    const own = getChatCoverage(USER);
    expect(own.get(HASH_A)).toBe(JANUARY_ISO);
    expect(own.get(HASH_B)).toBe(SETTINGS_FLOOR_ISO);
    expect(getSourceCoverage(USER).find((c) => c.source === "google_messages")?.coveredSince).toBe(SETTINGS_FLOOR_ISO);
  });

  it("a chat not read down to its floor (cap, not settled, gap) records no coverage of its own (W5)", async () => {
    await syncBoth(false, true);
    expect(getChatCoverage(USER).has(HASH_A)).toBe(false);
    expect(getChatCoverage(USER).get(HASH_B)).toBe(SETTINGS_FLOOR_ISO);
  });

  it("a chat already read back to its deal's start is not widened again, but its older texts are still kept (W6)", () => {
    recordChatCoverage(USER, HASH_A, JANUARY_ISO);
    const floors = track();
    expect(cacheChatFloorFor(JOB, USER, "conv-a", pplA.numbers)).toBeNull();
    expect(floors.get(HASH_A)).toBe(JANUARY);
    expect(takeCacheChats(JOB)!.widened).toBe(0);
  });

  it("a thread linked to a live deal widens its chat (no deal contact in it), at /match and in the claim (W10)", async () => {
    // Chat B is stored first (no deal contact), then linked to the January deal.
    track();
    staging.stageChat(JOB, USER, chat("conv-b", false), pplB, HASH_B);
    await staging.commit(JOB, USER, { floorMs: SETTINGS_FLOOR, cap: null, protectedSpans: [] }, commitWriter, () => undefined);
    takeCacheChats(JOB);
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id) VALUES ('co-b', ?, 't-jan', ?)").run(USER, `gmweb2-${HASH_B}`);
    track();
    expect(cacheChatFloorFor(JOB, USER, "conv-b", pplB.numbers)).toBe(JANUARY);
    expect(dealChatsForClaim(USER, SETTINGS_FLOOR, SETTINGS_FLOOR_ISO)).toEqual({ ids: ["conv-b"], floorISO: JANUARY_ISO });
  });

  it("dev window override: no widening at all (W9)", () => {
    track({ devOverride: true });
    expect(cacheChatFloorFor(JOB, USER, "conv-a", pplA.numbers)).toBeNull();
  });

  it("per-chat coverage only moves earlier", () => {
    recordChatCoverage(USER, HASH_A, JANUARY_ISO);
    recordChatCoverage(USER, HASH_A, SETTINGS_FLOOR_ISO);
    expect(getChatCoverage(USER).get(HASH_A)).toBe(JANUARY_ISO);
  });

  it("the claim names the deal chats not yet read back (conversation ids), never a Don't-sync chat, with the oldest deal start (W8)", async () => {
    // A first Sync stored chat A (by its numbers, a deal contact) without reading it back.
    await syncBoth(false, true);
    expect(dealChatsForClaim(USER, SETTINGS_FLOOR, SETTINGS_FLOOR_ISO)).toEqual({ ids: ["conv-a"], floorISO: JANUARY_ISO });
    db.prepare("INSERT INTO rcs_chat_exclusions (id, user_id, chat_hash, conversation_id) VALUES ('x1', ?, ?, 'conv-a')").run(USER, HASH_A);
    expect(dealChatsForClaim(USER, SETTINGS_FLOOR, SETTINGS_FLOOR_ISO)).toEqual({ ids: [], floorISO: null });
  });

  it("the claim is empty once the deal chat is read back", async () => {
    await syncBoth(true, true);
    expect(dealChatsForClaim(USER, SETTINGS_FLOOR, SETTINGS_FLOOR_ISO)).toEqual({ ids: [], floorISO: null });
  });

  it("the export gate and the Texts tab use the per-thread coverage of the deal's linked chat (W7)", async () => {
    await syncBoth(false, true);
    recordSourceCoverage(USER, "google_messages", SETTINGS_FLOOR_ISO, new Date().toISOString());
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id) VALUES ('co1', ?, 't-jan', ?)").run(USER, `gmweb2-${HASH_A}`);
    const gm = (gaps: Array<{ source: string }> | undefined) => (gaps ?? []).filter((g) => g.source === "google_messages");
    // Not read back yet: the source coverage (August) says "later" — the fallback can only over-warn.
    expect(gm(getTransactionTextCoverage("t-jan", USER, null).gaps)).toHaveLength(1);
    expect(gm((await checkExportCompleteness("t-jan", USER)).sourceGaps)).toHaveLength(1);
    // Read back to January: no gap for this deal.
    recordChatCoverage(USER, HASH_A, JANUARY_ISO);
    expect(gm(getTransactionTextCoverage("t-jan", USER, null).gaps)).toEqual([]);
    expect(gm((await checkExportCompleteness("t-jan", USER)).sourceGaps)).toEqual([]);
  });
});
