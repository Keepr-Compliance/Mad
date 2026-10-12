/**
 * @jest-environment node
 *
 * BACKLOG-3892 W — texts coverage warnings, on the REAL Keepr schema, through the real
 * persistence and the real readers (harness: iphoneCoverage-3892.test.ts).
 *  - W1: the END check — newer texts may be missing when the chosen source's last sync
 *        is more than a day before min(audit end, now); the Mac import records its run;
 *  - W2: warnings come from the CHOSEN source only (hasRows only when none is chosen);
 *  - W3: a switched phone keeps what the old phone covered, merged only where contiguous;
 *  - W3b: a phone's coverage never starts before its own oldest text (the new-phone cap);
 *  - W4: the least covered person is named ("Unknown" falls back to the handle).
 *
 * Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");

// A fresh userData directory per run (atRest.testIsolation): never a fixed shared path.
jest.mock("electron", () => ({
  app: {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    getPath: jest.fn(() => require("./helpers/testUserData").testUserDataDir()),
  },
}));
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
import { getIphoneDealCoverage } from "../iphoneCoverageService";
import {
  checkExportCompleteness,
  getAuditCoverage,
  getTransactionTextCoverage,
  recordSourceCoverage,
  sourceCoverageGaps,
} from "../auditCoverageService";
import { recordMacImportRun } from "../macImportMarker";
import type { SourceCoverage } from "../../types/auditCoverage";
import { handleKeys, type ChatFloorPlan } from "../iphoneChatFloors";
import type { SyncResult } from "../deviceSyncOrchestrator";
import type { iOSMessage, iOSConversation } from "../../types/iosMessages";
import { removeTestUserDataDir } from "./helpers/testUserData";

afterAll(() => removeTestUserDataDir());

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
  oldestTextMs?: number | null;
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
            ...("oldestTextMs" in opts ? { oldestTextMs: opts.oldestTextMs } : {}),
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
function contactOnDeal(txn: string, c: string, phone: string, name: string = c): void {
  db.prepare("INSERT OR IGNORE INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)").run(c, USER, name);
  db.prepare("INSERT OR IGNORE INTO contact_phones (id, contact_id, phone_e164) VALUES (?, ?, ?)").run(`p-${c}`, c, phone);
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, ?)").run(`${txn}-${c}`, txn, c);
}
function linkThread(txn: string, threadId: string): void {
  n += 1;
  db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id) VALUES (?, ?, ?, ?)").run(`co-${n}`, USER, txn, threadId);
}

beforeEach(() => {
  n = 0;
  db = new Driver!(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'u3892w@example.test', 'google', 'o-3892w')").run(USER);
  setDb(db as never);
});
afterEach(() => db?.close());

/** "Now" for every test here (Date only; timers stay real so persistence runs as in the app). */
const NOW = Date.UTC(2026, 9, 12, 12);
beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "hrtime", "performance"],
  });
});
afterAll(() => jest.useRealTimers());

const startGap = (txn: string, chosen: "iphone" | "mac" | "google_messages" | null = "iphone") =>
  getTransactionTextCoverage(txn, USER, chosen).gaps.find((g) => g.kind !== "newer" && g.source === (chosen ?? "iphone"));
const endGap = (txn: string, chosen: "iphone" | "mac" | "google_messages" = "iphone") =>
  getTransactionTextCoverage(txn, USER, chosen).gaps.find((g) => g.kind === "newer" && g.source === chosen);
function closedDeal(id: string, startedAt: string, closedAt: string): void {
  db.prepare("INSERT INTO transactions (id, user_id, property_address, status, started_at, closed_at) VALUES (?, ?, ?, 'active', ?, ?)").run(id, USER, `${id} Test St`, startedAt, closedAt);
}

describe("BACKLOG-3892 W1: sourceCoverageGaps end check (pure)", () => {
  const TOL = DAY;
  const cov = (lastSyncAt: string | null, extra: Partial<SourceCoverage> = {}): SourceCoverage[] => [
    { source: "iphone", coveredSince: "2020-01-01T00:00:00.000Z", lastSyncAt, approximate: false, hasRows: true, ...extra },
  ];
  const START = "2026-01-01T00:00:00.000Z";

  it("boundary: last sync at required end - 24 h - 1 ms is a gap; at - 24 h it is not (open deal: end = now)", () => {
    expect(sourceCoverageGaps(cov(iso(NOW - TOL - 1)), START, "iphone", null, NOW)).toEqual([
      expect.objectContaining({ source: "iphone", kind: "newer", lastSyncAt: iso(NOW - TOL - 1), requiredEndISO: iso(NOW) }),
    ]);
    expect(sourceCoverageGaps(cov(iso(NOW - TOL)), START, "iphone", null, NOW)).toEqual([]);
  });

  it("a deal that ended in the past is checked against its END, not now", () => {
    const end = NOW - 30 * DAY;
    expect(sourceCoverageGaps(cov(iso(end - 12 * 3_600_000)), START, "iphone", iso(end), NOW)).toEqual([]);
    expect(sourceCoverageGaps(cov(iso(end - TOL - 1)), START, "iphone", iso(end), NOW)).toEqual([
      expect.objectContaining({ kind: "newer", requiredEndISO: iso(end) }),
    ]);
    // An end in the future is capped at now.
    expect(sourceCoverageGaps(cov(iso(NOW - 2 * DAY)), START, "iphone", iso(NOW + 30 * DAY), NOW)).toEqual([
      expect.objectContaining({ kind: "newer", requiredEndISO: iso(NOW) }),
    ]);
  });

  it("no end line without start coverage (already 'never'), without a sync marker, or for the companion", () => {
    expect(sourceCoverageGaps(cov(iso(NOW - 9 * DAY), { coveredSince: null }), START, "iphone", null, NOW).map((g) => g.kind)).toEqual(["never"]);
    expect(sourceCoverageGaps(cov(null), START, "iphone", null, NOW)).toEqual([]);
    const companion: SourceCoverage[] = [{ source: "android_companion", coveredSince: "2020-01-01T00:00:00.000Z", lastSyncAt: iso(NOW - 9 * DAY), approximate: true, hasRows: true }];
    expect(sourceCoverageGaps(companion, START, "android_companion", null, NOW)).toEqual([]);
  });

  it("a source can have a start gap AND an end gap", () => {
    const gaps = sourceCoverageGaps(cov(iso(NOW - 5 * DAY), { coveredSince: "2026-06-01T00:00:00.000Z" }), START, "iphone", null, NOW);
    expect(gaps.map((g) => g.kind)).toEqual(["later", "newer"]);
  });
});

describe("BACKLOG-3892 W2: chosen source only (pure)", () => {
  const START = "2026-01-01T00:00:00.000Z";
  const coverage: SourceCoverage[] = [
    { source: "iphone", coveredSince: "2026-06-01T00:00:00.000Z", lastSyncAt: iso(NOW), approximate: false, hasRows: true },
    { source: "mac", coveredSince: "2025-01-01T00:00:00.000Z", lastSyncAt: iso(NOW), approximate: false, hasRows: true },
  ];
  it("chosen = mac with old iPhone texts: no iPhone line (the founder's false warning)", () => {
    expect(sourceCoverageGaps(coverage, START, "mac", null, NOW)).toEqual([]);
  });
  it("chosen = null keeps the hasRows sources (the likely wrong build hides everything)", () => {
    expect(sourceCoverageGaps(coverage, START, null, null, NOW).map((g) => g.source)).toEqual(["iphone"]);
  });
  it("chosen with no texts yet is still checked", () => {
    expect(sourceCoverageGaps([], START, "google_messages", null, NOW)).toEqual([expect.objectContaining({ source: "google_messages", kind: "never" })]);
  });
});

maybe("BACKLOG-3892 W: real schema", () => {
  it("W1 iPhone: an open deal reads 'newer' when the phone's last sync is over a day old; a sync today clears it", async () => {
    deal("t1", "2026-09-01");
    await persist(result({ startedAtMs: NOW - 2 * DAY, floorPlan: plan({ settings: Date.UTC(2026, 7, 1) }) }));
    expect(endGap("t1")).toMatchObject({ kind: "newer", lastSyncAt: iso(NOW - 2 * DAY), requiredEndISO: iso(NOW) });
    // Export: complete stays start-based, the end gap is reported for the gate.
    const exp = await checkExportCompleteness("t1", USER, "iphone");
    expect(exp).toMatchObject({ complete: true, iphoneGap: false, textEndGap: expect.objectContaining({ kind: "newer", source: "iphone" }) });
    await persist(result({ startedAtMs: NOW - 3_600_000, floorPlan: plan({ settings: Date.UTC(2026, 7, 1) }) }));
    expect(endGap("t1")).toBeUndefined();
    expect((await checkExportCompleteness("t1", USER, "iphone")).textEndGap).toBeUndefined();
  });

  it("W1: a closed deal is checked against its end date, not today", async () => {
    closedDeal("t1", "2026-08-01", "2026-09-01");
    await persist(result({ startedAtMs: Date.UTC(2026, 8, 3), floorPlan: plan({ settings: Date.UTC(2026, 6, 1) }) }));
    expect(endGap("t1")).toBeUndefined();
    closedDeal("t2", "2026-08-01", "2026-09-20");
    expect(endGap("t2")).toMatchObject({ kind: "newer" });
  });

  it("W1 create dialog: the proposed End Date is used (open = today)", async () => {
    await persist(result({ startedAtMs: Date.UTC(2026, 8, 3), floorPlan: plan({ settings: Date.UTC(2026, 6, 1) }) }));
    const open = await getAuditCoverage(USER, "2026-08-01T00:00:00.000Z", "iphone");
    expect(open.sourceGaps?.map((g) => g.kind)).toEqual(["newer"]);
    const ended = await getAuditCoverage(USER, "2026-08-01T00:00:00.000Z", "iphone", "2026-09-01");
    expect(ended.sourceGaps).toEqual([]);
  });

  it("W1 Mac: a completed import records its start as the Mac last sync; covered_since is untouched", () => {
    deal("t1", "2026-09-01");
    recordSourceCoverage(USER, "mac", "2025-01-01T00:00:00.000Z", iso(NOW - 10 * DAY));
    expect(endGap("t1", "mac")).toMatchObject({ kind: "newer", lastSyncAt: iso(NOW - 10 * DAY) });
    recordMacImportRun(USER, NOW - 3_600_000);
    expect(db.prepare("SELECT covered_since, last_sync_at FROM message_source_coverage WHERE user_id = ? AND source = 'mac'").get(USER)).toEqual({
      covered_since: "2025-01-01T00:00:00.000Z",
      last_sync_at: iso(NOW - 3_600_000),
    });
    expect(endGap("t1", "mac")).toBeUndefined();
  });

  it("W1 Google Messages: the cache commit's last_sync_at drives the end line", () => {
    deal("t1", "2026-09-01");
    recordSourceCoverage(USER, "google_messages", "2025-01-01T00:00:00.000Z", iso(NOW - 4 * DAY));
    expect(endGap("t1", "google_messages")).toMatchObject({ kind: "newer", source: "google_messages" });
  });

  it("W2: chosen = mac with old iPhone rows -> no iPhone line on the Texts tab or the export check", async () => {
    deal("t1", DEAL_START);
    storedText("ios-chat-1", "2026-09-01T00:00:00.000Z");
    await persist(result({ startedAtMs: NOW - 5 * DAY, floorPlan: plan({ settings: F }) }));
    recordSourceCoverage(USER, "mac", "2020-01-01T00:00:00.000Z", iso(NOW));
    expect(getTransactionTextCoverage("t1", USER, "mac").gaps.filter((g) => g.source === "iphone")).toEqual([]);
    expect((await checkExportCompleteness("t1", USER, "mac")).sourceGaps?.filter((g) => g.source === "iphone")).toEqual([]);
    // No source chosen: the iPhone texts the user has still count.
    expect(getTransactionTextCoverage("t1", USER, null).gaps.some((g) => g.source === "iphone")).toBe(true);
  });

  describe("W3: switched phone", () => {
    const A_FLOOR = Date.UTC(2024, 0, 1);
    const B_FLOOR = Date.UTC(2025, 4, 1);

    it("an old phone's interval joins the new phone's only when it reaches it (no covering the months between)", async () => {
      // Phone A read [2024-01-01, 2025-03-01]; phone B reads [2025-05-01, now].
      await persist(result({ udid: PHONE_A, startedAtMs: Date.UTC(2025, 2, 1), floorPlan: plan({ settings: A_FLOOR }) }));
      await persist(result({ udid: PHONE_B, startedAtMs: NOW - 3_600_000, floorPlan: plan({ settings: B_FLOOR }) }));
      deal("gap", "2025-04-01");
      deal("between", "2024-06-01");
      expect(startGap("gap")).toMatchObject({ kind: "later", coveredSince: iso(B_FLOOR) });
      expect(startGap("between")).toMatchObject({ kind: "later", coveredSince: iso(B_FLOOR) });
    });

    it("contiguity boundary: phone A ending one day before phone B starts does not join; ending the day B starts does (R1)", async () => {
      deal("t1", "2024-06-01");
      // Phone B reads [2025-05-01, now]. Phone A read [2024-01-01, B_FLOOR - 1 day]: a day-long hole.
      await persist(result({ udid: PHONE_A, startedAtMs: B_FLOOR - DAY, floorPlan: plan({ settings: A_FLOOR }) }));
      await persist(result({ udid: PHONE_B, startedAtMs: NOW - 3_600_000, floorPlan: plan({ settings: B_FLOOR }) }));
      expect(startGap("t1")).toMatchObject({ kind: "later", coveredSince: iso(B_FLOOR) });
      expect(getIphoneDealCoverage(USER, "t1")?.coveredSince).toBe(iso(B_FLOOR));
      // Phone A's last sync moves to exactly B's start: it reaches B, the intervals join.
      await persist(result({ udid: PHONE_A, startedAtMs: B_FLOOR, floorPlan: plan({ settings: A_FLOOR }) }));
      expect(startGap("t1")).toBeUndefined();
      expect(getIphoneDealCoverage(USER, "t1")?.coveredSince).toBe(iso(A_FLOOR));
    });

    it("contiguous phones: a deal phone A covered stays covered after phone B's first sync", async () => {
      // Phone A read [2024-01-01, 2025-06-01]; phone B reads [2025-05-01, now].
      await persist(result({ udid: PHONE_A, startedAtMs: Date.UTC(2025, 5, 1), floorPlan: plan({ settings: A_FLOOR }) }));
      deal("t1", "2024-06-01");
      expect(startGap("t1")).toBeUndefined();
      await persist(result({ udid: PHONE_B, startedAtMs: NOW - 3_600_000, floorPlan: plan({ settings: B_FLOOR }) }));
      expect(startGap("t1")).toBeUndefined();
      expect(getIphoneDealCoverage(USER, "t1")).toMatchObject({ udid: PHONE_B, coveredSince: iso(A_FLOOR), previousPhone: true, lastSyncAt: iso(NOW - 3_600_000) });
    });

    it("per person: the old phone's read-back of a deal contact carries over to the new phone", async () => {
      deal("t1", "2024-03-01");
      contactOnDeal("t1", "c1", P1, "Dana Reyes");
      const back = Date.UTC(2024, 1, 29);
      await persist(result({ udid: PHONE_A, startedAtMs: Date.UTC(2025, 5, 1), floorPlan: plan({ settings: Date.UTC(2025, 0, 1), handles: { [P1]: back } }) }));
      await persist(result({ udid: PHONE_B, startedAtMs: NOW - 3_600_000, floorPlan: plan({ settings: B_FLOOR }) }));
      expect(getIphoneDealCoverage(USER, "t1")?.coveredSince).toBe(iso(back));
      expect(startGap("t1")).toBeUndefined();
    });
  });

  describe("W3b: the new-phone cap", () => {
    it("a sync records the phone's oldest text; no value = no row", async () => {
      await persist(result({ oldestTextMs: Date.UTC(2025, 7, 1) }));
      await persist(result({ udid: PHONE_B, oldestTextMs: null }));
      expect(db.prepare("SELECT udid, oldest_text_at FROM iphone_device_span WHERE user_id = ?").all(USER)).toEqual([
        { udid: PHONE_A, oldest_text_at: iso(Date.UTC(2025, 7, 1)) },
      ]);
    });

    it("a new phone that never held the deal's texts does not cover the deal; the line names the previous phone", async () => {
      const oldest = Date.UTC(2025, 7, 1);
      deal("t1", "2025-06-01");
      contactOnDeal("t1", "c1", P1, "Dana Reyes");
      // Phone A, last synced long ago, read only back to 2025-01 (not contiguous with B).
      await persist(result({ udid: PHONE_A, startedAtMs: Date.UTC(2025, 2, 1), floorPlan: plan({ settings: Date.UTC(2025, 0, 1) }) }));
      // Phone B: a deal-floor read back to the deal start, but its oldest text is 2025-08-01.
      await persist(result({
        udid: PHONE_B,
        startedAtMs: NOW - 3_600_000,
        floorPlan: plan({ settings: F, handles: { [P1]: Date.UTC(2025, 5, 1) - DAY } }),
        oldestTextMs: oldest,
      }));
      expect(startGap("t1")).toMatchObject({ kind: "later", coveredSince: iso(oldest), cappedByPhone: iso(oldest), previousPhone: true, who: "Dana Reyes" });
      const exp = await checkExportCompleteness("t1", USER, "iphone");
      expect(exp).toMatchObject({ complete: false, iphoneGap: true, textStartGap: expect.objectContaining({ cappedByPhone: iso(oldest) }) });
    });

    it("an older phone is capped at its own oldest text too: joined coverage starts there, not at its settings floor (R2)", async () => {
      const jan = Date.UTC(2025, 0, 1);
      const mar = Date.UTC(2025, 2, 1);
      const jun = Date.UTC(2025, 5, 1);
      deal("t1", "2025-02-01");
      // Phone A: since Jan, but its oldest text is Mar; last sync Jun. Phone B (current): since Jun.
      await persist(result({ udid: PHONE_A, startedAtMs: jun, floorPlan: plan({ settings: jan }), oldestTextMs: mar }));
      await persist(result({ udid: PHONE_B, startedAtMs: NOW - 3_600_000, floorPlan: plan({ settings: jun }) }));
      expect(getIphoneDealCoverage(USER, "t1")?.coveredSince).toBe(iso(mar));
      expect(startGap("t1")).toMatchObject({ kind: "later", coveredSince: iso(mar) });
    });

    it("a single phone whose oldest text limits the start: capped, no previous phone", async () => {
      const oldest = Date.UTC(2025, 7, 1);
      deal("t1", "2025-06-01");
      await persist(result({ startedAtMs: NOW - 3_600_000, oldestTextMs: oldest }));
      expect(startGap("t1")).toMatchObject({ kind: "later", coveredSince: iso(oldest), cappedByPhone: iso(oldest), previousPhone: false });
    });

    it("the cap never moves coverage earlier: a phone read only to its floor is not capped", async () => {
      deal("t1", "2025-06-01");
      await persist(result({ startedAtMs: NOW - 3_600_000, floorPlan: plan({ settings: F }), oldestTextMs: Date.UTC(2020, 0, 1) }));
      expect(startGap("t1")).toMatchObject({ kind: "later", coveredSince: iso(F), cappedByPhone: null });
    });
  });

  describe("W4: naming the least covered person", () => {
    it("two contacts: the one covered less is named (not the first)", async () => {
      deal("t1", DEAL_START);
      contactOnDeal("t1", "c1", P1, "Alice Moreno");
      contactOnDeal("t1", "c2", P2, "Bob Tran");
      await persist(result({ startedAtMs: NOW - 3_600_000, floorPlan: plan({ settings: F, handles: { [P1]: DEAL_FLOOR } }) }));
      expect(startGap("t1")).toMatchObject({ kind: "later", coveredSince: iso(F), who: "Bob Tran" });
    });

    it('"Unknown" (or an empty name) falls back to the phone number', async () => {
      deal("t1", DEAL_START);
      contactOnDeal("t1", "c1", P1, "Unknown");
      await persist(result({ startedAtMs: NOW - 3_600_000, floorPlan: plan({ settings: F }) }));
      expect(startGap("t1")).toMatchObject({ who: P1 });
    });

    it("no contact on the deal: no name", async () => {
      deal("t1", DEAL_START);
      await persist(result({ startedAtMs: NOW - 3_600_000, floorPlan: plan({ settings: F }) }));
      expect(startGap("t1")).toMatchObject({ kind: "later", who: null });
    });
  });
});
