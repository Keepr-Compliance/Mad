/**
 * @jest-environment node
 *
 * BACKLOG-3892 S2 — iPhone text coverage, on the REAL Keepr schema, through the real
 * persistence (iPhoneSyncStorageService.persistSyncResult) and the real readers
 * (auditCoverageService). Only the sms.db parse is replaced by the SyncResult it hands
 * over, and the per-source floors worker by the same SQL on this connection.
 *
 * SR plan review 9f0e0cf4 D1-D6 and S1 review bb7f71b9 C2/C4:
 *  - D1: the iPhone "covered since" is the phone's own row, never the oldest text;
 *  - D2: a deal is covered as far as its LEAST covered contact handle / linked chat;
 *        a handle with no row counts as the settings floor, so the gap shows until a
 *        sync reads that person's chats back;
 *  - D4: contiguity, the upgrader seed read BEFORE this run's inserts, per phone;
 *  - D5: nothing advances on a run with a failed read, or a cancelled run;
 *  - D6: rows are per phone — a replacement phone reusing chat ROWIDs inherits nothing;
 *  - C2: rows come from the floors the run APPLIED;
 *  - D3b: the export check for an iPhone user flips on the D2 rows (both directions).
 *
 * Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");

jest.mock("electron", () => ({ app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3892-coverage") } }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop }, logService: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../permissionService", () => ({ __esModule: true, default: { checkFullDiskAccess: jest.fn(async () => ({ hasPermission: false })) } }));
jest.mock("../db/externalContactDbService");
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: { resolveAttachmentPath: jest.fn().mockReturnValue(null), flushRejectedPathSummary: jest.fn() },
}));
jest.mock("../../utils/preferenceHelper", () => ({ isContactSourceEnabled: jest.fn().mockResolvedValue(true) }));
jest.mock("../databaseService", () => {
  const sync = jest.requireActual("../db/syncDbService");
  return {
    __esModule: true,
    default: new Proxy({}, { get: (_t, name: string) => (typeof sync[name] === "function" ? sync[name] : undefined) }),
  };
});
// The per-source floors normally run on a worker; here the same SQL on this connection.
jest.mock("../sourceCoverageFloors", () => {
  const actual = jest.requireActual("../sourceCoverageFloors");
  const { dbAll } = jest.requireActual("../db/core/dbConnection");
  const { MESSAGES_FLOOR_BY_SOURCE_SQL } = jest.requireActual("../db/auditCoverageSql");
  return { ...actual, readSourceFloors: async (userId: string) => dbAll(MESSAGES_FLOOR_BY_SOURCE_SQL, [userId]) };
});

import { setDb } from "../db/core/dbConnection";
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import { mergeRunInterval, getIphoneDealCoverage } from "../iphoneCoverageService";
import { iphoneStoredTextSpan } from "../db/iphoneCoverageDbService";
import { checkExportCompleteness, getAuditCoverage, getSourceCoverage, getTransactionTextCoverage } from "../auditCoverageService";
import { handleKeys, type ChatFloorPlan } from "../iphoneChatFloors";
import type { SyncResult } from "../deviceSyncOrchestrator";
import type { iOSMessage, iOSConversation } from "../../types/iosMessages";

function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    new Database(":memory:").close();
    return Database;
  } catch (error) {
    process.stderr.write(`[3892-coverage] real sqlite driver unavailable (${String(error).slice(0, 80)}); run under Electron\n`);
    return null;
  }
}
const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

const USER = "user-3892-cov";
const DAY = 86_400_000;
const PHONE_A = "udid-phone-a";
const PHONE_B = "udid-phone-b";
/** The lookback floor of these runs (1.5 months before 2026-10-10). */
const F = Date.UTC(2026, 7, 25);
/** Run start times. */
const T1 = Date.UTC(2026, 9, 10, 12);
const T2 = Date.UTC(2026, 9, 11, 12);
/** A deal starting 2025-12-01 (before F); its floor = start − 24 h. */
const DEAL_START = "2025-12-01";
const DEAL_FLOOR = Date.UTC(2025, 11, 1) - DAY;
const P1 = "+12025550101";
const P2 = "+12025550102";
let db: DatabaseType;
let n = 0;

const iso = (ms: number): string => new Date(ms).toISOString();

function plan(opts: { settings: number | null; handles?: Record<string, number> }): ChatFloorPlan {
  const handleFloors = new Map<string, number>();
  for (const [h, f] of Object.entries(opts.handles ?? {})) for (const k of handleKeys(h)) handleFloors.set(k, f);
  return { settingsFloorMs: opts.settings, handleFloors, linkedChatFloors: new Map() };
}

function guid(): string {
  n += 1;
  const h = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${h}`;
}

/** The SyncResult a sync hands persistence: one message per (chatId, dateMs). */
function result(opts: {
  udid?: string;
  startedAtMs?: number;
  floorPlan?: ChatFloorPlan;
  chatFloors?: Array<[number, number | null]>;
  failures?: number | undefined;
  texts?: Array<[number, number]>;
  noRun?: boolean;
}): SyncResult {
  const messages: iOSMessage[] = [];
  const byChat = new Map<number, iOSConversation>();
  for (const [chatId, dateMs] of opts.texts ?? []) {
    const m: iOSMessage = {
      id: n + 1000, guid: guid(), text: "t", audioTranscript: null, handle: P2, isFromMe: false,
      date: new Date(dateMs), dateRead: null, dateDelivered: null, service: "iMessage", attachments: [],
    } as unknown as iOSMessage;
    messages.push(m);
    const conv = byChat.get(chatId) ?? ({ chatId, chatIdentifier: P2, displayName: null, participants: [P2], messages: [], lastMessage: new Date(dateMs), isGroupChat: false } as unknown as iOSConversation);
    conv.messages.push(m);
    byChat.set(chatId, conv);
  }
  return {
    success: true,
    messages,
    contacts: [],
    conversations: [...byChat.values()],
    error: null,
    duration: 0,
    sessionId: `s-${n}`,
    ...("failures" in opts ? { chatReadFailures: opts.failures } : { chatReadFailures: 0 }),
    ...(opts.noRun
      ? {}
      : {
          coverageRun: {
            udid: opts.udid ?? PHONE_A,
            startedAtMs: opts.startedAtMs ?? T1,
            ...(opts.floorPlan ? { floorPlan: opts.floorPlan } : {}),
            chatFloors: opts.chatFloors ?? [],
          },
        }),
  } as SyncResult;
}

async function persist(r: SyncResult, cancel?: { cancelled: boolean }): Promise<void> {
  const out = await iPhoneSyncStorageService.persistSyncResult(USER, r, undefined, undefined, r.sessionId, cancel);
  if (!cancel) expect(out.success).toBe(true);
}

function deviceRows(): Array<{ udid: string; covered_since: string; last_sync_at: string; approximate: number }> {
  return db.prepare("SELECT udid, covered_since, last_sync_at, approximate FROM iphone_device_coverage WHERE user_id = ? ORDER BY udid").all(USER) as never;
}
function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}
function storedText(threadId: string, sentAt: string): void {
  n += 1;
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, thread_id, sent_at, metadata)
     VALUES (?, ?, 'imessage', ?, 'inbound', 'x', ?, ?, ?)`,
  ).run(`old-${n}`, USER, `ext-old-${n}`, threadId, sentAt, JSON.stringify({ source: "iphone_sync" }));
}
function deal(id: string, startedAt: string): void {
  db.prepare("INSERT INTO transactions (id, user_id, property_address, status, started_at) VALUES (?, ?, ?, 'active', ?)").run(id, USER, `${id} Test St`, startedAt);
}
function contactOnDeal(txn: string, c: string, phone: string): void {
  db.prepare("INSERT OR IGNORE INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)").run(c, USER, c);
  db.prepare("INSERT OR IGNORE INTO contact_phones (id, contact_id, phone_e164) VALUES (?, ?, ?)").run(`p-${c}`, c, phone);
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, ?)").run(`${txn}-${c}`, txn, c);
}
function linkThread(txn: string, threadId: string): void {
  n += 1;
  db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id) VALUES (?, ?, ?, ?)").run(`co-${n}`, USER, txn, threadId);
}
const iphoneGapOf = (txn: string) => getTransactionTextCoverage(txn, USER, "iphone").gaps.find((g) => g.source === "iphone");

beforeEach(() => {
  n = 0;
  db = new Driver!(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'u3892c@example.test', 'google', 'o-3892c')").run(USER);
  setDb(db as never);
});
afterEach(() => db.close());

describe("BACKLOG-3892 S2: mergeRunInterval (D4 contiguity)", () => {
  it("merges only when the prior interval reaches the run's floor; otherwise restarts at the floor", () => {
    const prior = { coveredSinceMs: Date.UTC(2024, 0, 1), lastSyncMs: F, approximate: true };
    expect(mergeRunInterval(prior, F, T1)).toEqual({ coveredSinceMs: Date.UTC(2024, 0, 1), lastSyncMs: T1, approximate: true });
    expect(mergeRunInterval({ ...prior, lastSyncMs: F - 1 }, F, T1)).toEqual({ coveredSinceMs: F, lastSyncMs: T1, approximate: false });
    expect(mergeRunInterval(null, F, T1)).toEqual({ coveredSinceMs: F, lastSyncMs: T1, approximate: false });
    // A run reading further back than the prior interval is exact, not approximate.
    expect(mergeRunInterval(prior, Date.UTC(2023, 0, 1), T1)).toEqual({ coveredSinceMs: Date.UTC(2023, 0, 1), lastSyncMs: T1, approximate: false });
  });
});

maybe("BACKLOG-3892 S2: iPhone coverage (real schema, real persistence)", () => {
  it("D4 seed: a fresh upgrader's history is kept (approximate) — read BEFORE this run's inserts", async () => {
    storedText("ios-chat-1", "2024-01-01T00:00:00.000Z");
    storedText("ios-chat-1", "2026-09-01T00:00:00.000Z"); // last sync was after F
    await persist(result({ floorPlan: plan({ settings: F }), texts: [[1, T1 - DAY]] }));
    expect(deviceRows()).toEqual([{ udid: PHONE_A, covered_since: "2024-01-01T00:00:00.000Z", last_sync_at: iso(T1), approximate: 1 }]);
  });

  it("R3: the seed span is answered from the covering index — no SCAN of messages — and only for a single-user database", () => {
    for (let i = 0; i < 3000; i++) storedText(`ios-chat-${i % 50}`, new Date(Date.UTC(2024, 0, 1) + i * 3_600_000).toISOString());
    storedText("sms-thread-1", "2020-01-01T00:00:00.000Z"); // not an iPhone thread: outside the range
    db.exec("ANALYZE");
    const seen: string[] = [];
    const real = db.prepare.bind(db);
    const spy = jest.spyOn(db, "prepare").mockImplementation(((text: string) => { seen.push(text); return real(text); }) as never);
    const span = iphoneStoredTextSpan(USER);
    spy.mockRestore();
    expect(span).toMatchObject({ n: 3000, floor: "2024-01-01T00:00:00.000Z" });
    const stmt = seen.find((t) => /MIN\(sent_at\)/.test(t));
    expect(stmt).toBeDefined();
    const plan = (real(`EXPLAIN QUERY PLAN ${stmt}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    expect(plan).toMatch(/COVERING INDEX idx_messages_thread_sent/);
    expect(plan).not.toMatch(/SCAN/);
    // Without a user_id term the index cannot tell users apart: a second local user = no seed.
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('other', 'o3892@example.test', 'google', 'o-other')").run();
    expect(iphoneStoredTextSpan(USER)).toBeUndefined();
  });

  it("D4 seed: a STALE upgrader (newest stored text before F) is not seeded covered, even though this run inserts newer texts", async () => {
    storedText("ios-chat-1", "2024-01-01T00:00:00.000Z");
    storedText("ios-chat-1", "2026-01-01T00:00:00.000Z");
    await persist(result({ floorPlan: plan({ settings: F }), texts: [[1, T1 - DAY]] }));
    expect(deviceRows()).toEqual([{ udid: PHONE_A, covered_since: iso(F), last_sync_at: iso(T1), approximate: 0 }]);
  });

  it("D4: a second phone does not merge into the first phone's interval (and is not seeded)", async () => {
    storedText("ios-chat-1", "2024-01-01T00:00:00.000Z");
    storedText("ios-chat-1", "2026-09-01T00:00:00.000Z");
    await persist(result({ floorPlan: plan({ settings: F }) }));
    await persist(result({ udid: PHONE_B, startedAtMs: T2, floorPlan: plan({ settings: F }) }));
    expect(deviceRows().map((r) => [r.udid, r.covered_since])).toEqual([
      [PHONE_A, "2024-01-01T00:00:00.000Z"],
      [PHONE_B, iso(F)],
    ]);
  });

  it("D5: a run with a failed sms.db read (or an unknown count) advances nothing; a cancelled run neither", async () => {
    const p = plan({ settings: F, handles: { [P1]: DEAL_FLOOR } });
    await persist(result({ floorPlan: p, chatFloors: [[3, DEAL_FLOOR]], failures: 1 }));
    await persist(result({ floorPlan: p, chatFloors: [[3, DEAL_FLOOR]], failures: undefined }));
    // Cancelled AFTER its messages were inserted (the first check passes): rolled back.
    let checks = 0;
    const cancelLate = { get cancelled() { checks += 1; return checks > 1; } };
    await persist(result({ floorPlan: p, chatFloors: [[3, DEAL_FLOOR]], texts: [[3, T1 - DAY]] }), cancelLate);
    expect(checks).toBeGreaterThan(1);
    expect(countRows("messages")).toBe(0);
    await persist(result({ floorPlan: p, noRun: true }));
    expect(countRows("iphone_device_coverage") + countRows("iphone_handle_coverage") + countRows("iphone_chat_coverage")).toBe(0);
    // Positive control: the same run with zero failures records all three kinds.
    await persist(result({ floorPlan: p, chatFloors: [[3, DEAL_FLOOR]] }));
    expect([countRows("iphone_device_coverage"), countRows("iphone_handle_coverage") > 0, countRows("iphone_chat_coverage")]).toEqual([1, true, 1]);
  });

  it("a run with no plan (every chat read in full) covers everything the phone holds", async () => {
    await persist(result({}));
    expect(deviceRows()[0].covered_since).toBe(iso(0));
  });

  it("D1: the iPhone source is the phone's row — never the oldest stored text (the most likely wrong fix)", async () => {
    // Texts of a deal chat read back a year sit in the store …
    storedText("ios-chat-9", "2025-01-01T00:00:00.000Z");
    // … with no phone row yet: not "covered since 2025-01-01", but unknown.
    expect(getSourceCoverage(USER).find((c) => c.source === "iphone")).toMatchObject({ coveredSince: null, hasRows: true });
    await persist(result({ floorPlan: plan({ settings: F }) }));
    expect(getSourceCoverage(USER).find((c) => c.source === "iphone")).toMatchObject({ coveredSince: iso(F), approximate: false });
    // The create dialog for a deal starting before F sees the iPhone gap.
    const cov = await getAuditCoverage(USER, `${DEAL_START}T00:00:00.000Z`, "iphone");
    expect(cov.sourceGaps?.find((g) => g.source === "iphone")).toMatchObject({ kind: "later", coveredSince: iso(F) });
  });

  it("D2: a deal before the floor whose contact's chats were floored reads NOT covered until a sync reads them back; then the export check clears", async () => {
    deal("t1", DEAL_START);
    contactOnDeal("t1", "c1", P1);
    // Run 1: the contact was not on a deal yet, so the plan did not widen them.
    await persist(result({ floorPlan: plan({ settings: F }), texts: [[1, T1 - DAY]] }));
    expect(getIphoneDealCoverage(USER, "t1")?.coveredSince).toBe(iso(F));
    expect(iphoneGapOf("t1")).toMatchObject({ kind: "later" });
    const before = await checkExportCompleteness("t1", USER, "iphone");
    expect(before).toMatchObject({ complete: false, iphoneGap: true, iphoneCoveredSince: iso(F) });
    // Run 2: the plan reads that person back to the deal floor (they have no older texts).
    await persist(result({ startedAtMs: T2, floorPlan: plan({ settings: F, handles: { [P1]: DEAL_FLOOR } }) }));
    expect(getIphoneDealCoverage(USER, "t1")?.coveredSince).toBe(iso(DEAL_FLOOR));
    expect(iphoneGapOf("t1")).toBeUndefined();
    const after = await checkExportCompleteness("t1", USER, "iphone");
    // Complete on the iPhone rows although the oldest stored text is after the deal start.
    expect(after).toMatchObject({ complete: true, iphoneGap: false, needsMessagesImport: true });
    // Not an iPhone user: the Mac rule is unchanged (no iPhone fields, incomplete).
    const mac = await checkExportCompleteness("t1", USER, null);
    expect(mac.complete).toBe(false);
    expect(mac.iphoneGap).toBeUndefined();
  });

  it("D2: the deal is only as covered as its LEAST covered person", async () => {
    deal("t1", DEAL_START);
    contactOnDeal("t1", "c1", P1);
    contactOnDeal("t1", "c2", P2);
    await persist(result({ floorPlan: plan({ settings: F, handles: { [P1]: DEAL_FLOOR } }) }));
    expect(getIphoneDealCoverage(USER, "t1")?.coveredSince).toBe(iso(F));
    expect(iphoneGapOf("t1")).toMatchObject({ kind: "later" });
  });

  it("D2: a handle row whose scan no longer reaches the phone's interval is stale and does not count", async () => {
    deal("t1", DEAL_START);
    contactOnDeal("t1", "c1", P1);
    await persist(result({ floorPlan: plan({ settings: F, handles: { [P1]: DEAL_FLOOR } }) }));
    expect(iphoneGapOf("t1")).toBeUndefined();
    // Months without a sync: the next run's floor is after the last one, so the
    // phone's interval restarts there; P1 was not in that run's plan.
    const later = Date.UTC(2027, 3, 1);
    await persist(result({ startedAtMs: later + 45 * DAY, floorPlan: plan({ settings: later }) }));
    expect(getIphoneDealCoverage(USER, "t1")?.coveredSince).toBe(iso(later));
    expect(iphoneGapOf("t1")).toMatchObject({ kind: "later" });
  });

  it("D2/D4 (SR R2): a person's / chat's row does not merge across an unread gap — the scan must reach the new floor", async () => {
    deal("t1", DEAL_START);
    contactOnDeal("t1", "c1", P1);
    linkThread("t1", "ios-chat-4");
    // Run 1 read P1 and chat 4 back to the deal floor (row = [DEAL_FLOOR, T1]).
    await persist(result({ floorPlan: plan({ settings: F, handles: { [P1]: DEAL_FLOOR } }), chatFloors: [[4, DEAL_FLOOR]] }));
    // Months later the phone's interval restarted at `later`; this run read P1 / chat 4 only
    // from `f`, which is AFTER run 1's scan (T1): texts in (T1, f) were never read.
    const later = Date.UTC(2027, 3, 1);
    const f = later - 10 * DAY;
    expect(f).toBeGreaterThan(T1);
    await persist(result({ startedAtMs: later + 45 * DAY, floorPlan: plan({ settings: later, handles: { [P1]: f } }), chatFloors: [[4, f]] }));
    // The rows restart at f — they must not claim DEAL_FLOOR across the gap.
    expect(db.prepare("SELECT covered_since FROM iphone_chat_coverage WHERE chat_rowid = 4").all()).toEqual([{ covered_since: iso(f) }]);
    const handleSince = (db.prepare("SELECT covered_since FROM iphone_handle_coverage").all() as Array<{ covered_since: string }>).map((r) => r.covered_since);
    expect(handleSince.length).toBeGreaterThan(0);
    expect(new Set(handleSince)).toEqual(new Set([iso(f)]));
    // And the deal reads covered only back to f (still a gap: it starts before f).
    expect(getIphoneDealCoverage(USER, "t1")?.coveredSince).toBe(iso(f));
    expect(iphoneGapOf("t1")).toMatchObject({ kind: "later" });
  });

  it("C2: chat rows come from the floor each chat was ACTUALLY read to (a group read back by one member)", async () => {
    deal("t2", "2025-06-01");
    linkThread("t2", "ios-chat-4");
    const applied = Date.UTC(2025, 5, 1) - DAY;
    // The plan has no linked floor for chat 4; the run read it back via a member.
    await persist(result({ floorPlan: plan({ settings: F }), chatFloors: [[4, applied], [5, F]] }));
    expect(db.prepare("SELECT chat_rowid, covered_since FROM iphone_chat_coverage").all()).toEqual([{ chat_rowid: 4, covered_since: iso(applied) }]);
    expect(iphoneGapOf("t2")).toBeUndefined();
  });

  it("D6: a replacement phone reusing chat ROWIDs does not inherit the old phone's coverage", async () => {
    deal("t2", "2025-06-01");
    linkThread("t2", "ios-chat-4");
    const applied = Date.UTC(2025, 5, 1) - DAY;
    await persist(result({ floorPlan: plan({ settings: F }), chatFloors: [[4, applied]] }));
    expect(iphoneGapOf("t2")).toBeUndefined();
    // Phone B syncs later; its chat 4 (a different conversation) was read to F only.
    await persist(result({ udid: PHONE_B, startedAtMs: T2, floorPlan: plan({ settings: F }), chatFloors: [[4, F]] }));
    expect(getIphoneDealCoverage(USER, "t2")).toMatchObject({ udid: PHONE_B, coveredSince: iso(F) });
    expect(iphoneGapOf("t2")).toMatchObject({ kind: "later" });
  });
});
