/**
 * @jest-environment node
 *
 * BACKLOG-3892 S5 — "Get older texts" from the kept iPhone backup, end to end on REAL
 * parts: the real Keepr schema and persistence (harness from iphoneCoverage-W-3892), a
 * real sealed chain read through the real BackupAtRest (harness from backupAtRest.test),
 * the real iOSMessagesParser over a real sms.db file, the real parse-copy area.
 *
 * Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import crypto from "crypto";
import plist from "simple-plist";
import type { Database as DatabaseType } from "better-sqlite3";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
// The parser opens sms.db through the module name, which the jest config maps to a mock.
jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(require("path").join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")),
);
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
jest.mock("../../utils/preferenceHelper", () => ({ isContactSourceEnabled: jest.fn().mockResolvedValue(true) }));
jest.mock("../databaseService", () => {
  const sync = jest.requireActual("../db/syncDbService");
  return {
    __esModule: true,
    default: new Proxy({}, { get: (_t, name: string) => (typeof sync[name] === "function" ? sync[name] : undefined) }),
  };
});
jest.mock("../sourceCoverageFloors", () => {
  const actual = jest.requireActual("../sourceCoverageFloors");
  const { dbAll } = jest.requireActual("../db/core/dbConnection");
  const { MESSAGES_FLOOR_BY_SOURCE_SQL } = jest.requireActual("../db/auditCoverageSql");
  return { ...actual, readSourceFloors: async (userId: string) => dbAll(MESSAGES_FLOOR_BY_SOURCE_SQL, [userId]) };
});

import { setDb } from "../db/core/dbConnection";
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import { getIphoneDealCoverage } from "../iphoneCoverageService";
import { getTransactionTextCoverage } from "../auditCoverageService";
import { handleKeys, type ChatFloorPlan } from "../iphoneChatFloors";
import { iOSMessagesParser } from "../iosMessagesParser";
import { BACKUP_READ_STOPPED, BackupAtRest, BackupAtRestRefusal } from "../atRest/backupAtRest";
import { BACKUP_MISSING_SENTENCE } from "../atRest/backupProblem";
import { createFileCrypto, type KeyResolver } from "../atRest/fileCrypto";
import { createMarkerStore } from "../atRest/markers";
import { BackupDecryptionService, SMS_DB_FILE_ID } from "../backupDecryptionService";
import { IphoneBackfillService, type BackfillDeps, type BackfillMessagesParser } from "../iphoneBackfillService";
import type { SyncResult } from "../deviceSyncOrchestrator";
import { computeTransactionDateRange } from "../../utils/emailDateRange";
import { removeTestUserDataDir } from "./helpers/testUserData";

afterAll(() => removeTestUserDataDir());

function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    new Database(":memory:").close();
    return Database;
  } catch (error) {
    process.stderr.write(`[3892-S5] real sqlite driver unavailable (${String(error).slice(0, 80)}); run under Electron\n`);
    return null;
  }
}
const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

const USER = "user-3892-s5";
const DAY = 86_400_000;
const UDID = "00008110-000A1B2C3D4E5F60";
/** The settings floor the last sync read to, and when it ran. */
const F = Date.UTC(2026, 7, 25);
const T1 = Date.UTC(2026, 9, 1, 12);
const NOW = Date.UTC(2026, 9, 12, 12);
/** A deal starting 2025-12-01 (before F): floor = start − 24 h. */
const DEAL_START = "2025-12-01";
// The producer's own audit start (computeTransactionDateRange reads a bare date in local time).
const DEAL_FLOOR = computeTransactionDateRange({ started_at: DEAL_START, created_at: null, closed_at: null }).start.getTime() - DAY;
const P1 = "+12025550101"; // the deal's contact
const P9 = "+12025550199"; // someone else
const APPLE_EPOCH_MS = 978_307_200_000;
const ns = (ms: number): bigint => BigInt(ms - APPLE_EPOCH_MS) * 1_000_000n;
const iso = (ms: number): string => new Date(ms).toISOString();

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32);
const resolver: KeyResolver = { currentKey: async () => ({ keyId: KEY_ID, key: KEY }), keyFor: async () => KEY };
const files = createFileCrypto(resolver, { chunkSize: 64 });

let db: DatabaseType;
let root: string;
let backups: string;
let chain: string;
let tmpRoot: string;

const ATT_IN = "Library/SMS/Attachments/ab/01/IN_1.jpg";
const ATT_OUT = "Library/SMS/Attachments/cd/02/OUT_1.jpg";
const attId = (rel: string): string => crypto.createHash("sha1").update(`MediaDomain-${rel}`).digest("hex");

/** One text in the phone's sms.db: [chat ROWID, guid, epoch ms or null (undated)]. */
type Text = [number, string, number | null];

/**
 * The phone's sms.db (columns the parser reads; see iosMessagesParser.test.ts).
 * chat 1 = P1 (the deal's contact, 1:1); chat 2 = P9 only; chat 3 = a group of P1 + P9.
 */
function writeSmsDb(file: string, texts: Text[], opts: { noMembers?: boolean } = {}): void {
  const sms = new Driver!(file) as unknown as DatabaseType;
  sms.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, audio_transcript TEXT,
      handle_id INTEGER, is_from_me INTEGER, date INTEGER, date_read INTEGER, date_delivered INTEGER, service TEXT);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT, transfer_name TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO handle VALUES (1, '${P1}', 'iMessage'), (9, '${P9}', 'iMessage');
    INSERT INTO chat VALUES (1, 'c1', '${P1}', NULL), (2, 'c2', '${P9}', NULL), (3, 'c3', 'chat300', 'Group');
  `);
  // A failed member read (D5) is produced by the parser's own error path: no join table.
  if (opts.noMembers) sms.exec("DROP TABLE chat_handle_join");
  else sms.exec("INSERT INTO chat_handle_join VALUES (1, 1), (2, 9), (3, 1), (3, 9)");
  // Attachments: one on an in-range text, one on a text the backfill does not read.
  sms.exec(`INSERT INTO attachment VALUES (1, 'a1', '~/${ATT_IN}', 'image/jpeg', 'in.jpg'), (2, 'a2', '~/${ATT_OUT}', 'image/jpeg', 'out.jpg')`);
  const attach = sms.prepare("INSERT INTO message_attachment_join VALUES (?, ?)");
  const ins = sms.prepare("INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, service) VALUES (?, ?, 'hi', ?, 0, ?, 'iMessage')");
  const join = sms.prepare("INSERT INTO chat_message_join VALUES (?, ?)");
  texts.forEach(([chat, guid, ms], i) => {
    ins.run(i + 1, guid, chat === 2 ? 9 : 1, ms === null ? null : ns(ms));
    join.run(chat, i + 1);
    if (guid === "g-1-in-a") attach.run(i + 1, 1);
    if (guid === "g-1-recent") attach.run(i + 1, 2);
  });
  sms.close();
}

/** A kept chain shaped like idevicebackup2 output (backupAtRest.test.ts makeChain), holding `texts`. */
function makeChain(texts: Text[], opts: { noMembers?: boolean } = {}): void {
  nodeFs.mkdirSync(chain, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(chain, "Info.plist"), plist.stringify({ "Device Name": "Test" }));
  nodeFs.writeFileSync(nodePath.join(chain, "Status.plist"), plist.stringify({ SnapshotState: "finished" }));
  nodeFs.writeFileSync(nodePath.join(chain, "Manifest.plist"), plist.stringify({ IsEncrypted: false }));
  const m = new Driver!(nodePath.join(chain, "Manifest.db")) as unknown as DatabaseType;
  m.exec("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)");
  m.prepare("INSERT INTO Files VALUES (?, 'HomeDomain', 'Library/SMS/sms.db', 1, ?)").run(SMS_DB_FILE_ID, Buffer.alloc(0));
  for (const rel of [ATT_IN, ATT_OUT]) {
    const id = attId(rel);
    m.prepare("INSERT INTO Files VALUES (?, 'MediaDomain', ?, 1, ?)").run(id, rel, Buffer.alloc(0));
    nodeFs.mkdirSync(nodePath.join(chain, id.slice(0, 2)), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(chain, id.slice(0, 2), id), crypto.randomBytes(200));
  }
  m.close();
  const smsPath = nodePath.join(chain, SMS_DB_FILE_ID.slice(0, 2), SMS_DB_FILE_ID);
  nodeFs.mkdirSync(nodePath.dirname(smsPath), { recursive: true });
  writeSmsDb(smsPath, texts, opts);
}

function atRest(): BackupAtRest {
  return new BackupAtRest({
    backupsRoot: () => backups,
    files: () => files,
    markers: () => createMarkerStore({ userData: () => root }),
    ensureKey: async () => undefined,
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    sleep: async () => undefined,
    log: () => undefined,
    concurrency: 2,
    chunkSize: 64,
  });
}

let rest: BackupAtRest;
/**
 * Attachment files storage found in the parse copy, through the REAL resolver it uses
 * (iOSMessagesParser.resolveAttachmentPath). The attachment writer itself (data-key
 * sealed files, attachment tables) is out of scope here; this proves the copy holds
 * exactly the files storage will look for.
 */
let attachmentsFound: string[];
let reportProblem: jest.Mock;
let autoLink: jest.Mock;

function engine(overrides: Partial<BackfillDeps> = {}): IphoneBackfillService {
  return new IphoneBackfillService({
    atRest: () => rest,
    copies: new BackupDecryptionService({ tmpRoot: () => tmpRoot }),
    newParser: () => new iOSMessagesParser() as unknown as BackfillMessagesParser,
    persist: (u, r, p, prog, s, c) => iPhoneSyncStorageService.persistSyncResult(u, r, p, prog, s, c),
    autoLink,
    otherWork: () => null,
    reportProblem,
    ...overrides,
  });
}

/** The sync before the backfill: read [F, T1] on this phone (no deal yet), so the phone's interval is [F, T1]. */
async function priorSync(opts: { oldestTextMs?: number | null } = {}): Promise<void> {
  const floorPlan: ChatFloorPlan = { settingsFloorMs: F, handleFloors: new Map(), linkedChatFloors: new Map() };
  const r = {
    success: true, messages: [], contacts: [], conversations: [], error: null, duration: 0, sessionId: "s-prior",
    chatReadFailures: 0,
    coverageRun: { udid: UDID, startedAtMs: T1, floorPlan, chatFloors: [], ...("oldestTextMs" in opts ? { oldestTextMs: opts.oldestTextMs } : {}) },
  } as unknown as SyncResult;
  expect((await iPhoneSyncStorageService.persistSyncResult(USER, r, undefined, undefined, "s-prior")).success).toBe(true);
}

function deal(id: string, startedAt: string, submission = "not_submitted"): void {
  db.prepare("INSERT INTO transactions (id, user_id, property_address, status, started_at, submission_status) VALUES (?, ?, ?, 'active', ?, ?)").run(id, USER, `${id} Test St`, startedAt, submission);
  db.prepare("INSERT OR IGNORE INTO contacts (id, user_id, display_name) VALUES ('c1', ?, 'Pat')").run(USER);
  db.prepare("INSERT OR IGNORE INTO contact_phones (id, contact_id, phone_e164) VALUES ('p-c1', 'c1', ?)").run(P1);
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, 'c1')").run(`${id}-c1`, id);
}
const stored = (thread?: string): string[] =>
  (thread
    ? db.prepare("SELECT external_id FROM messages WHERE user_id = ? AND thread_id = ? ORDER BY external_id").all(USER, thread)
    : db.prepare("SELECT external_id FROM messages WHERE user_id = ? ORDER BY external_id").all(USER)
  ).map((r) => (r as { external_id: string }).external_id);
const deviceRow = () => db.prepare("SELECT covered_since, last_sync_at FROM iphone_device_coverage WHERE user_id = ? AND udid = ?").get(USER, UDID);
const handleRow = (key: string) =>
  db.prepare("SELECT covered_since AS coveredSince, scanned_at AS scannedAt FROM iphone_handle_coverage WHERE user_id = ? AND udid = ? AND handle_key = ?").get(USER, UDID, key) as
    | { coveredSince: string; scannedAt: string }
    | undefined;
const startGap = (txn: string) => getTransactionTextCoverage(txn, USER, "iphone").gaps.find((g) => g.source === "iphone" && g.kind !== "newer");
const endGap = (txn: string) => getTransactionTextCoverage(txn, USER, "iphone").gaps.find((g) => g.source === "iphone" && g.kind === "newer");
const parseCopies = (): string[] => (nodeFs.existsSync(tmpRoot) ? nodeFs.readdirSync(tmpRoot) : []);

/** The phone's texts: chat 1 (P1) across the range, chat 2 (P9 only) and chat 3 (group with P1). */
const IN_RANGE_1 = Date.UTC(2025, 11, 15);
const IN_RANGE_2 = Date.UTC(2026, 3, 1);
const TEXTS: Text[] = [
  [1, "g-1-veryold", Date.UTC(2025, 5, 1)], // before the deal floor
  [1, "g-1-in-a", IN_RANGE_1],
  [1, "g-1-in-b", IN_RANGE_2],
  [1, "g-1-ceiling", F], // read by the sync already ([F, T1]): not by the backfill
  [1, "g-1-recent", Date.UTC(2026, 8, 20)],
  [1, "g-1-undated", null], // the sync kept it; the backfill never reads it
  [2, "g-2-in", IN_RANGE_1], // not a deal chat
  [3, "g-3-in", IN_RANGE_2], // group with the deal contact
];

beforeEach(() => {
  db = new Driver!(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'u3892s5@example.test', 'google', 'o-3892s5')").run(USER);
  setDb(db as never);
  root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-s5-"));
  backups = nodePath.join(root, "Backups");
  chain = nodePath.join(backups, UDID);
  tmpRoot = nodePath.join(root, "at-rest-tmp");
  rest = atRest();
  reportProblem = jest.fn();
  autoLink = jest.fn().mockResolvedValue(undefined);
  attachmentsFound = [];
  jest
    .spyOn(iPhoneSyncStorageService as unknown as { storeAttachments: (...a: unknown[]) => Promise<unknown> }, "storeAttachments")
    .mockImplementation(async (...args: unknown[]) => {
      const [, messages, backupPath] = args as [string, Array<{ attachments: Array<{ filename: string }> }>, string];
      for (const m of messages)
        for (const a of m.attachments) {
          const at = iOSMessagesParser.resolveAttachmentPath(backupPath, a.filename);
          if (at && nodeFs.existsSync(at)) attachmentsFound.push(nodePath.basename(at));
        }
      return { stored: attachmentsFound.length, skipped: 0, skippedByReason: {} };
    });
});
afterEach(() => {
  jest.restoreAllMocks();
  db?.close();
  nodeFs.rmSync(root, { recursive: true, force: true });
});
beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "hrtime", "performance"],
  });
});
afterAll(() => jest.useRealTimers());

maybe("BACKLOG-3892 S5: backfill from the kept backup (real parts)", () => {
  it("fills only the deal's chats in [deal floor, ceiling); the start gap clears; device row, end gap and chain untouched (B1, B2, B-all, B7)", async () => {
    makeChain(TEXTS);
    await rest.migrate(UDID); // sealed at rest, as the app keeps it
    await priorSync();
    deal("t1", DEAL_START);
    expect(startGap("t1")).toBeDefined();
    const endBefore = endGap("t1");
    expect(endBefore).toBeDefined();
    const deviceBefore = deviceRow();

    const copies = jest.spyOn(rest, "buildParseCopy");
    const svc = engine();
    const avail = svc.availability(USER, "t1");
    expect(avail).toMatchObject({ available: true, udid: UDID, floorMs: DEAL_FLOOR, ceilingMs: F, cappedByPhone: false });

    const r = await svc.backfill(USER, "t1");
    expect(r).toMatchObject({ success: true, messagesStored: 3, coverageRecorded: true, coveredSinceAfter: iso(DEAL_FLOOR) });
    // B-all: chat 2 (no deal person) is never read; chat 3 (a group with the deal contact) is.
    expect(stored("ios-chat-2")).toEqual([]);
    expect(stored().sort()).toEqual(["g-1-in-a", "g-1-in-b", "g-3-in"]);
    // Two copies: sms.db, then only the attachment of a text that was read.
    expect(copies.mock.calls.map((c) => [...(c[2]?.only ?? [])])).toEqual([[SMS_DB_FILE_ID], [attId(ATT_IN)]]);
    expect(attachmentsFound).toEqual([attId(ATT_IN)]);
    // B1: the device row and the end check are unchanged.
    expect(deviceRow()).toEqual(deviceBefore);
    // The end line is still there, on the same last sync (only its start field moved).
    expect(endGap("t1")).toMatchObject({ kind: "newer", lastSyncAt: endBefore!.lastSyncAt, requiredEndISO: endBefore!.requiredEndISO });
    expect(endBefore!.lastSyncAt).toBe(iso(T1));
    expect(startGap("t1")).toBeUndefined();
    // Rows stamped with the phone's existing last sync.
    for (const k of handleKeys(P1)) expect(handleRow(k)).toEqual({ coveredSince: iso(DEAL_FLOOR), scannedAt: iso(T1) });
    // B3: no parse copy left, the phone released, auto-link ran.
    expect(parseCopies()).toEqual([]);
    expect(rest.busyReason(UDID)).toBeNull();
    expect(autoLink).toHaveBeenCalledWith(USER);
    expect(svc.availability(USER, "t1")).toEqual({ available: false, reason: "no-gap" });
  });

  it("B6: a re-run stores nothing twice (coverage reset by hand, same backup)", async () => {
    makeChain(TEXTS);
    await priorSync();
    deal("t1", DEAL_START);
    const svc = engine();
    expect((await svc.backfill(USER, "t1")).messagesStored).toBe(3);
    db.prepare("DELETE FROM iphone_handle_coverage").run();
    expect(svc.availability(USER, "t1").available).toBe(true);
    const again = await svc.backfill(USER, "t1");
    expect(again).toMatchObject({ success: true, messagesStored: 0 });
    expect(stored().sort()).toEqual(["g-1-in-a", "g-1-in-b", "g-3-in"]);
  });

  it("B-cap: a phone that holds texts only from 2026-01-10 fills to that date, never the deal start (no span recorded before)", async () => {
    const OLDEST = Date.UTC(2026, 0, 10);
    makeChain([
      [1, "g-1-oldest", OLDEST],
      [1, "g-1-in-b", IN_RANGE_2],
      [1, "g-1-recent", Date.UTC(2026, 8, 20)],
    ]);
    await priorSync({ oldestTextMs: null }); // a phone synced before the span was recorded
    deal("t1", DEAL_START);
    const r = await engine().backfill(USER, "t1");
    expect(r).toMatchObject({ success: true, messagesStored: 2, coverageRecorded: true, cappedByPhone: true });
    for (const k of handleKeys(P1)) expect(handleRow(k)?.coveredSince).toBe(iso(OLDEST));
    expect(getIphoneDealCoverage(USER, "t1")?.coveredSince).toBe(iso(OLDEST));
    expect(db.prepare("SELECT oldest_text_at AS o FROM iphone_device_span WHERE user_id = ? AND udid = ?").get(USER, UDID)).toEqual({ o: iso(OLDEST) });
    // The deal still starts before what the phone holds: the start line stays.
    expect(startGap("t1")).toBeDefined();
  });

  it("B-cap (planner): with the phone's oldest text on record, what is offered starts there; a phone holding nothing older than the ceiling offers nothing", async () => {
    const OLDEST = Date.UTC(2026, 0, 10);
    makeChain([[1, "g-1-oldest", OLDEST], [1, "g-1-recent", Date.UTC(2026, 8, 20)]]);
    await priorSync({ oldestTextMs: OLDEST });
    deal("t1", DEAL_START);
    expect(engine().availability(USER, "t1")).toMatchObject({ available: true, floorMs: OLDEST, ceilingMs: F, cappedByPhone: true });
    db.prepare("UPDATE iphone_device_span SET oldest_text_at = ?").run(iso(F));
    expect(engine().availability(USER, "t1")).toEqual({ available: false, reason: "nothing-older" });
  });

  it("B-lock: a deal with the broker is refused before anything is read, stored or linked", async () => {
    makeChain(TEXTS);
    await priorSync();
    deal("t1", DEAL_START, "submitted");
    const svc = engine();
    expect(svc.availability(USER, "t1")).toEqual({ available: false, reason: "locked" });
    expect(await svc.backfill(USER, "t1")).toMatchObject({ success: false, reason: "locked", messagesStored: 0 });
    expect(stored()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM communications WHERE transaction_id = 't1'").get()).toEqual({ c: 0 });
    expect(autoLink).not.toHaveBeenCalled();
    expect(parseCopies()).toEqual([]);
  });

  it("B3: a throw in the middle of the copy leaves no parse copy and releases the phone", async () => {
    makeChain(TEXTS);
    await priorSync();
    deal("t1", DEAL_START);
    const real = rest.buildParseCopy.bind(rest);
    jest.spyOn(rest, "buildParseCopy").mockImplementation(async (udid, dir, opts) => {
      await real(udid, dir, opts); // the plaintext copy is on disk now
      throw Object.assign(new Error("disk went away"), { code: "EIO" });
    });
    const r = await engine().backfill(USER, "t1");
    expect(r).toMatchObject({ success: false, reason: "error", messagesStored: 0 });
    expect(parseCopies()).toEqual([]);
    expect(rest.busyReason(UDID)).toBeNull();
    expect(stored()).toEqual([]);
  });

  it("cancel while storing rolls the stored texts back; coverage does not move; nothing left on disk", async () => {
    makeChain(TEXTS);
    await priorSync();
    deal("t1", DEAL_START);
    const svc = engine();
    const r = await svc.backfill(USER, "t1", (p) => {
      if (p.phase === "saving") svc.cancel();
    });
    expect(r).toMatchObject({ success: false, reason: "cancelled", messagesStored: 0 });
    expect(stored()).toEqual([]);
    for (const k of handleKeys(P1)) expect(handleRow(k)).toBeUndefined();
    expect(parseCopies()).toEqual([]);
  });

  it("a sync taking the phone mid-copy ends the backfill as cancelled (no report), nothing stored or left", async () => {
    makeChain(TEXTS);
    await priorSync();
    deal("t1", DEAL_START);
    jest.spyOn(rest, "buildParseCopy").mockRejectedValue(new BackupAtRestRefusal("cancelled", BACKUP_READ_STOPPED));
    expect(await engine().backfill(USER, "t1")).toMatchObject({ success: false, reason: "cancelled", messagesStored: 0 });
    expect(reportProblem).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
    expect(parseCopies()).toEqual([]);
    expect(rest.busyReason(UDID)).toBeNull();
  });

  it("no-gap matches the start warning: coverage within a day after the deal start offers nothing", async () => {
    makeChain(TEXTS);
    await priorSync();
    deal("t1", DEAL_START);
    const start = DEAL_FLOOR + DAY;
    for (const k of handleKeys(P1)) {
      db.prepare("INSERT INTO iphone_handle_coverage (user_id, udid, handle_key, covered_since, scanned_at) VALUES (?, ?, ?, ?, ?)").run(USER, UDID, k, iso(start + DAY), iso(T1));
    }
    expect(startGap("t1")).toBeUndefined();
    expect(engine().availability(USER, "t1")).toEqual({ available: false, reason: "no-gap" });
    db.prepare("UPDATE iphone_handle_coverage SET covered_since = ?").run(iso(start + DAY + 1));
    expect(startGap("t1")).toBeDefined();
    expect(engine().availability(USER, "t1")).toMatchObject({ available: true });
  });

  it("D5: chats whose people cannot be read are not read and coverage does not move (the gap stays)", async () => {
    makeChain(TEXTS, { noMembers: true });
    await priorSync();
    deal("t1", DEAL_START);
    const r = await engine().backfill(USER, "t1");
    expect(r).toMatchObject({ success: true, coverageRecorded: false, messagesStored: 0 });
    for (const k of handleKeys(P1)) expect(handleRow(k)).toBeUndefined();
    expect(startGap("t1")).toBeDefined();
    expect(parseCopies()).toEqual([]);
  });

  it("refusals: no backup here -> 'missing' with the approved sentence and one report; other work -> busy", async () => {
    await priorSync();
    deal("t1", DEAL_START);
    const svc = engine();
    expect(svc.availability(USER, "t1")).toEqual({ available: false, reason: "missing", message: BACKUP_MISSING_SENTENCE });
    expect(reportProblem).not.toHaveBeenCalled();
    expect(await svc.backfill(USER, "t1")).toMatchObject({ success: false, reason: "missing", message: BACKUP_MISSING_SENTENCE });
    expect(reportProblem).toHaveBeenCalledTimes(1);
    expect(reportProblem).toHaveBeenCalledWith("missing");
    makeChain(TEXTS);
    const busy = engine({ otherWork: () => "sync" });
    expect(busy.availability(USER, "t1")).toMatchObject({ available: false, reason: "busy" });
    expect(await busy.backfill(USER, "t1")).toMatchObject({ success: false, reason: "busy" });
    expect(stored()).toEqual([]);
  });
});
