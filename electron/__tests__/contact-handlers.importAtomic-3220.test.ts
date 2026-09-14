/**
 * @jest-environment node
 *
 * BACKLOG-3220 — ONE `contacts:import` CALL SAVES EVERYTHING IT WAS GIVEN, OR NOTHING.
 *
 * ===========================================================================
 * WHAT IS UNDER TEST
 * ===========================================================================
 * The handler's whole write phase — marking legacy rows imported, their
 * crosswalk rows and copied addresses, the re-link of already-claimed records,
 * the batch insert of new contacts and their links — runs in ONE synchronous
 * `dbTransaction`. The write-atomicity guard cannot prove that: a no-op
 * `dbTransaction(() => {})` anywhere in the handler also clears the unit
 * (BACKLOG-3352). These sweeps are the proof.
 *
 * ===========================================================================
 * THIS DRIVES THE REAL HANDLER AGAINST A REAL, FILE-BACKED SQLITE
 * ===========================================================================
 * `dbConnection` routes to a real handle and a REAL transaction (the helper's,
 * which nests via SAVEPOINT and refuses a promise-returning callback exactly as
 * better-sqlite3 does). `contactDbService`, `contactSourceLinkDbService` and
 * `contactSourceValues` are real. Every `run`/`get`/`all` the handler issues is
 * counted as a statement boundary, and the clean run enumerates them, so the
 * sweeps below cover every statement rather than a sample.
 *
 *   C1 CRASH SWEEP. A SECOND connection on the same file reads what is committed
 *      immediately before and after every statement — what a process death at
 *      that instant would leave. The invariant is JOINT: the tuple
 *      (is_imported, source, crosswalk keys, emails, phones) across ALL touched
 *      contacts equals BEFORE-for-all or AFTER-for-all. A per-contact invariant
 *      cannot tell one transaction from one transaction per contact; S4 can.
 *
 *   C2 ERROR SWEEP. Every statement, READS INCLUDED, throws once. The final
 *      joint state must be BEFORE or AFTER; BEFORE means `success === false`;
 *      `success === true` means AFTER. A writes-only sweep cannot see a catch
 *      left around a SELECT (measured during planning: 15/15 green writes-only,
 *      4 red with reads swept).
 *
 *   C3 The ASYNC backfill facades throw synchronously if the handler calls
 *      them: inside the callback an async call loses its error path.
 *
 *   C4 Preconditions: the clean run succeeds with no error, writes something,
 *      changes state, and every sweep fires at every boundary. Without them a
 *      handler that throws before its first statement makes both sweeps loop
 *      zero times and pass.
 *
 *   C1-TYPE (compile time). Every function the transaction calls directly must
 *      stay synchronous. Re-adding `async` to `markContactAsImported` passes
 *      `tsc`, eslint and every other suite; `npm run type-check:tests` fails on
 *      the pin below.
 *
 * A post-commit read failing leaves everything saved with `success: false`.
 * That is allowed ("reports failure whenever nothing was saved" — not the
 * converse) and is counted, not forbidden, in C2.
 *
 * ===========================================================================
 * FIXTURES
 * ===========================================================================
 *   S1R  transcribed from the only producer of an `isFromDatabase` row,
 *        `contacts:get-available` STEP 1 (contactHandlers.ts `availableContacts.push`
 *        with `isFromDatabase: true`).
 *   S1F  INVENTED@075d0cc68 — no producer emits an `is_imported = 0` row carrying
 *        a source identity; it covers statements the live producer cannot reach;
 *        BACKLOG-1717 may create one.
 *   S2   picker row transcribed from STEP 2 (the shadow-table loop); database
 *        state constructed: a claimed record whose shadow row gained values.
 *   S3   same picker shape; a new record whose shadow row holds more than the row.
 *   S4   INVENTED@075d0cc68 — no live caller sends more than one record (both
 *        live screens pass `[record]`); it is the only case that separates one
 *        transaction from one transaction per contact; BACKLOG-1717 may create a
 *        multi-record caller. No live claim rests on S1F or S4 alone.
 *
 * Addresses are RFC 2606 `example.com` and NANP 555-01xx.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from "fs";
import os from "os";
import path from "path";
import type { IpcMainInvokeEvent } from "electron";
import type databaseServiceType from "../services/databaseService";
import type { applyLinkedSourceValuesOrThrow } from "../services/contactSourceValues";
import type { findContactIdBySourceRecord } from "../services/db/contactSourceLinkDbService";
import { CONTACT_IDENTITY_SCHEMA } from "../services/__tests__/helpers/contactIdentitySchema";
import { openTestDb, currentEngine, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";

// ---------------------------------------------------------------------------
// C1-TYPE — the compile-time pin. `false` here is a type error on assignment.
// ---------------------------------------------------------------------------
type MustBeSync<F extends (...a: never[]) => unknown> =
  ReturnType<F> extends PromiseLike<unknown> ? false : true;

const SYNC_PINS: [
  MustBeSync<typeof databaseServiceType.markContactAsImported>,
  MustBeSync<typeof databaseServiceType.backfillContactEmailsSync>,
  MustBeSync<typeof databaseServiceType.backfillContactPhonesSync>,
  MustBeSync<typeof databaseServiceType.createContactsBatch>,
  MustBeSync<typeof applyLinkedSourceValuesOrThrow>,
  MustBeSync<typeof findContactIdBySourceRecord>,
] = [true, true, true, true, true, true];

// ---------------------------------------------------------------------------
// Statement counting
// ---------------------------------------------------------------------------
let realDb: TestDb | null = null;
let observer: TestDb | null = null;

const probe = {
  count: 0,
  writes: 0,
  labels: [] as string[],
  throwAt: -1,
  snapshotAt: -1,
  pre: null as string | null,
  post: null as string | null,
  snapshotFn: null as null | (() => string),
  txDepth: 0,
};
const WRITE = /\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM)\b/i;

function boundary<T>(sqlText: string, kind: string, exec: () => T): T {
  probe.count++;
  if (WRITE.test(sqlText)) probe.writes++;
  const n = probe.count;
  probe.labels.push(
    `${probe.txDepth > 0 ? "tx" : "--"} ${kind} ${sqlText.replace(/\s+/g, " ").trim().slice(0, 60)}`,
  );
  if (n === probe.throwAt) throw new Error(`forced failure at statement ${n}`);
  if (n === probe.snapshotAt && probe.snapshotFn) probe.pre = probe.snapshotFn();
  const result = exec();
  if (n === probe.snapshotAt && probe.snapshotFn) probe.post = probe.snapshotFn();
  return result;
}

const countedDb = {
  prepare(sqlText: string) {
    const stmt = realDb!.prepare(sqlText);
    return {
      run: (...p: unknown[]) => boundary(sqlText, "run", () => stmt.run(...p)),
      get: (...p: unknown[]) => boundary(sqlText, "get", () => stmt.get(...p)),
      all: (...p: unknown[]) => boundary(sqlText, "all", () => stmt.all(...p)),
    };
  },
  exec: (s: string) => realDb!.exec(s),
  close: () => realDb!.close(),
  transaction: <T>(fn: () => T) => realDb!.transaction(fn),
};

const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/tmp") },
}));

// REAL SQL and a REAL transaction. `txDepth` only labels statements tx/--.
jest.mock("../services/db/core/dbConnection", () => ({
  ensureDb: () => countedDb,
  dbAll: (sql: string, params: unknown[] = []) => countedDb.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) => countedDb.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = countedDb.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => {
    probe.txDepth++;
    try {
      return countedDb.transaction(fn)();
    } finally {
      probe.txDepth--;
    }
  },
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../services/databaseService", () => {
  const real = jest.requireActual("../services/db/contactDbService");
  // C3: the async facades must never be reached from inside the transaction.
  const asyncFacade = (name: string) =>
    jest.fn(() => {
      throw new Error(`C3: contacts:import called the ASYNC facade ${name}; it escapes dbTransaction`);
    });
  return {
    __esModule: true,
    default: {
      getUserById: jest.fn((id: string) => Promise.resolve({ id })),
      isInitialized: jest.fn(() => true),
      markContactAsImported: (id: string, source?: string) => real.markContactAsImported(id, source),
      backfillContactEmails: asyncFacade("backfillContactEmails"),
      backfillContactPhones: asyncFacade("backfillContactPhones"),
      backfillContactEmailsSync: (id: string, emails: string[], source?: string) =>
        real.backfillContactEmailsSync(id, emails, source),
      backfillContactPhonesSync: (id: string, phones: string[], source?: string) =>
        real.backfillContactPhonesSync(id, phones, source),
      createContactsBatch: (rows: any[], onProgress?: any) => real.createContactsBatch(rows, onProgress),
      getContactById: jest.fn((id: string) =>
        Promise.resolve(countedDb.prepare("SELECT * FROM contacts WHERE id = ?").get(id) ?? null),
      ),
    },
  };
});

jest.mock("../services/contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(() =>
    Promise.resolve({ phoneToContactInfo: {}, contacts: [], status: { loaded: true } }),
  ),
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logContactAction: jest.fn() },
}));

jest.mock("../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../utils/preferenceHelper", () => ({
  __esModule: true,
  isContactSourceEnabled: jest.fn(() => Promise.resolve(true)),
}));

jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), fetchContacts: jest.fn() },
}));

jest.mock("../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn(), sync: jest.fn() },
}));

jest.mock("../workers/contactWorkerPool", () => ({
  __esModule: true,
  isPoolReady: jest.fn(() => false),
  queryContacts: jest.fn(() => Promise.resolve([])),
}));

/** No sync runs: every crosswalk row and copied address comes from the import. */
jest.mock("../services/contactSourceLinker", () => ({
  __esModule: true,
  linkExternalContactsForUser: jest.fn(() => {
    throw new Error("no sync may run in this suite (BACKLOG-3220)");
  }),
  isContactOnFrozenTransaction: jest.fn(() => false),
}));

jest.mock("../services/contactLinkingScheduler", () => ({
  __esModule: true,
  cancelPendingContactLinking: jest.fn(),
  configureContactLinking: jest.fn(),
  requestContactLinking: jest.fn(),
  runContactLinkingNow: jest.fn(() => Promise.resolve()),
}));

import { registerContactHandlers } from "../handlers/contactHandlers";

const USER = "550e8400-e29b-41d4-a716-446655440000"; // pii-allow-uuid: the RFC 4122 example UUID, invented
const SHA = "075d0cc68";
let dir = "";

function openFresh(): void {
  try {
    observer?.close();
  } catch {
    /* already closed */
  }
  try {
    realDb?.close();
  } catch {
    /* already closed */
  }
  const file = path.join(dir, "import-atomic.db");
  for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    fs.rmSync(f, { force: true });
  }
  realDb = openTestDb(file);
  realDb.exec(CONTACT_IDENTITY_SCHEMA);
  // Transcribed from electron/database/schema.sql (the `contacts` block). The
  // shared fixture lacks it and `markContactAsImported` writes it. SQLite
  // refuses a non-constant default on a table that already has rows, so this
  // runs BEFORE any seeding.
  realDb.exec("ALTER TABLE contacts ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP");
  observer = openTestDb(file);
}

interface Scenario {
  name: string;
  seed: (db: TestDb) => void;
  input: () => any[];
  touched: (db: TestDb) => string[];
  keyOf: (db: TestDb, id: string) => string;
  expectedKeys: string[];
}

function tuple(db: TestDb, id: string): string {
  const c = db.prepare("SELECT is_imported, source FROM contacts WHERE id = ?").get(id) as any;
  if (!c) return "ABSENT";
  const links = (
    db
      .prepare(
        "SELECT source_type || '/' || source_record_id AS k FROM contact_source_links WHERE contact_id = ? ORDER BY k",
      )
      .all(id) as Array<{ k: string }>
  ).map((r) => r.k.replace(/origin:[0-9a-f-]+/, "origin:*"));
  const emails = (
    db.prepare("SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY email").all(id) as Array<{
      email: string;
    }>
  ).map((r) => r.email);
  const phones = (
    db
      .prepare("SELECT phone_e164 FROM contact_phones WHERE contact_id = ? ORDER BY phone_e164")
      .all(id) as Array<{ phone_e164: string }>
  ).map((r) => r.phone_e164);
  return JSON.stringify({ imp: c.is_imported, src: c.source, links, emails, phones });
}

/** One string for every contact the scenario can touch. */
function jointState(db: TestDb, sc: Scenario): string {
  const out: Record<string, string> = {};
  for (const key of sc.expectedKeys) out[key] = "ABSENT";
  for (const id of sc.touched(db)) out[sc.keyOf(db, id)] = tuple(db, id);
  return JSON.stringify(
    Object.keys(out)
      .sort()
      .map((k) => [k, out[k]]),
  );
}

const byName = (db: TestDb, id: string) =>
  (db.prepare("SELECT display_name AS n FROM contacts WHERE id = ?").get(id) as { n: string }).n;

function legacyRendererShaped(): Scenario {
  return {
    name: "S1R existing-DB row, renderer-shaped (no identity, its own values)",
    seed: (db) => {
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES ('L1', ?, 'Legacy One', 'contacts_app', 0)",
      ).run(USER);
      db.prepare(
        "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES ('le1','L1','legacy.one@example.com',1,'import')",
      ).run();
      db.prepare(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source) VALUES ('lp1','L1','+14155550101','(415) 555-0101','4155550101',1,'import')",
      ).run();
    },
    input: () => [
      {
        id: "L1",
        name: "Legacy One",
        phone: "+14155550101",
        email: "legacy.one@example.com",
        company: null,
        source: "contacts_app",
        isFromDatabase: true,
        allPhones: ["+14155550101"],
        allEmails: ["legacy.one@example.com"],
        last_communication_at: null,
      },
    ],
    touched: () => ["L1"],
    keyOf: () => "L1",
    expectedKeys: ["L1"],
  };
}

function legacyWithIdentity(): Scenario {
  return {
    name: `S1F INVENTED@${SHA} existing-DB row carrying a source identity and new values`,
    seed: (db) => {
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES ('L2', ?, 'Legacy Two', 'contacts_app', 0)",
      ).run(USER);
      db.prepare(
        "INSERT INTO external_contacts (id, user_id, name, phones_json, emails_json, external_record_id, source) VALUES ('ext-L2', ?, 'Legacy Two', ?, ?, 'rec-L2', 'macos')",
      ).run(
        USER,
        JSON.stringify(["+14155550122", "+14155550123"]),
        JSON.stringify(["two.a@example.com", "two.b@example.com", "two.c@example.com"]),
      );
    },
    input: () => [
      {
        id: "L2",
        name: "Legacy Two",
        phone: null,
        email: null,
        company: null,
        source: "contacts_app",
        isFromDatabase: true,
        allPhones: ["+14155550122", "+14155550129"],
        allEmails: ["two.a@example.com", "two.picker@example.com"],
        externalRecordId: "rec-L2",
        externalSourceType: "macos",
        externalUuid: null,
      },
    ],
    touched: () => ["L2"],
    keyOf: () => "L2",
    expectedKeys: ["L2"],
  };
}

function claimedByExisting(): Scenario {
  return {
    name: "S2 already-claimed record whose shadow row gained values",
    seed: (db) => {
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES ('C2', ?, 'Claimed Two', 'contacts_app', 1)",
      ).run(USER);
      db.prepare(
        "INSERT INTO contact_source_links (id, user_id, contact_id, source_type, source_record_id, match_method) VALUES ('lk2', ?, 'C2', 'macos', 'rec-2', 'source_id')",
      ).run(USER);
      db.prepare(
        "INSERT INTO external_contacts (id, user_id, name, phones_json, emails_json, external_record_id, source) VALUES ('ext-2', ?, 'Claimed Two', ?, ?, 'rec-2', 'macos')",
      ).run(
        USER,
        JSON.stringify(["+14155550131", "+14155550132"]),
        JSON.stringify(["c2.a@example.com", "c2.b@example.com"]),
      );
    },
    input: () => [
      {
        id: "ext-2",
        name: "Claimed Two",
        phone: "+14155550131",
        email: "c2.a@example.com",
        company: null,
        source: "contacts_app",
        allPhones: ["+14155550131", "+14155550132"],
        allEmails: ["c2.a@example.com", "c2.b@example.com"],
        isFromDatabase: false,
        last_communication_at: null,
        externalRecordId: "rec-2",
        externalSourceType: "macos",
        externalUuid: null,
      },
    ],
    touched: () => ["C2"],
    keyOf: () => "C2",
    expectedKeys: ["C2"],
  };
}

function brandNew(): Scenario {
  return {
    name: "S3 new record whose shadow row holds more than the picker row",
    seed: (db) => {
      db.prepare(
        "INSERT INTO external_contacts (id, user_id, name, phones_json, emails_json, external_record_id, source) VALUES ('ext-3', ?, 'Fresh Three', ?, ?, 'rec-3', 'macos')",
      ).run(
        USER,
        JSON.stringify(["+14155550141", "+14155550142"]),
        JSON.stringify(["f3.a@example.com", "f3.b@example.com", "f3.c@example.com"]),
      );
    },
    input: () => [
      {
        id: "ext-3",
        name: "Fresh Three",
        phone: "+14155550141",
        email: "f3.a@example.com",
        company: null,
        source: "contacts_app",
        allPhones: ["+14155550141"],
        allEmails: ["f3.a@example.com"],
        isFromDatabase: false,
        last_communication_at: null,
        externalRecordId: "rec-3",
        externalSourceType: "macos",
        externalUuid: null,
      },
    ],
    touched: (db) =>
      (db.prepare("SELECT id FROM contacts WHERE display_name = 'Fresh Three'").all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    keyOf: byName,
    expectedKeys: ["Fresh Three"],
  };
}

function mixedBatch(): Scenario {
  const a = legacyWithIdentity();
  const b = claimedByExisting();
  const c = brandNew();
  return {
    name: `S4 INVENTED@${SHA} three records in one call (existing-DB + claimed + new)`,
    seed: (db) => {
      a.seed(db);
      b.seed(db);
      c.seed(db);
    },
    input: () => [...a.input(), ...b.input(), ...c.input()],
    touched: (db) => [...a.touched(db), ...b.touched(db), ...c.touched(db)],
    keyOf: (db, id) => (id === "L2" ? "L2" : id === "C2" ? "C2" : byName(db, id)),
    expectedKeys: ["C2", "Fresh Three", "L2"],
  };
}

const SCENARIOS = [legacyRendererShaped, legacyWithIdentity, claimedByExisting, brandNew, mixedBatch];

function resetProbe(): void {
  probe.count = 0;
  probe.writes = 0;
  probe.labels = [];
  probe.throwAt = -1;
  probe.snapshotAt = -1;
  probe.pre = null;
  probe.post = null;
  probe.snapshotFn = null;
}

// Diagnostic only: keeps the jest worker alive if a promise is abandoned inside
// the callback (an async call), so the red arrives as an assertion below
// instead of a crashed worker. It is not itself a control.
const keepWorkerAlive = (): void => undefined;

async function runImport(sc: Scenario): Promise<{ success: boolean; error?: string }> {
  const res = await registeredHandlers.get("contacts:import")({} as IpcMainInvokeEvent, USER, sc.input());
  // Let anything the handler abandoned settle inside THIS run.
  await new Promise((r) => setImmediate(r));
  return res;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3220-"));
  process.on("unhandledRejection", keepWorkerAlive);
  registerContactHandlers(null as any);
});

afterAll(() => {
  process.off("unhandledRejection", keepWorkerAlive);
  try {
    observer?.close();
  } catch {
    /* already closed */
  }
  try {
    realDb?.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

it("runs on a known engine", () => {
  openFresh();
  expect(["better-sqlite3", "node:sqlite"]).toContain(currentEngine());
});

it("C1-TYPE: every function the import transaction calls directly is synchronous", () => {
  // The assertion that matters is the tuple type above; this only keeps it used.
  expect(SYNC_PINS).toEqual([true, true, true, true, true, true]);
});

describe.each(SCENARIOS.map((make) => [make().name, make] as const))("%s", (_name, make) => {
  const sc = make();
  let before = "";
  let after = "";
  let total = 0;
  let writes = 0;
  let labels: string[] = [];
  let clean: { success: boolean; error?: string } = { success: false, error: "not run" };

  beforeAll(async () => {
    openFresh();
    sc.seed(realDb!);
    before = jointState(realDb!, sc);
    resetProbe();
    clean = await runImport(sc);
    total = probe.count;
    writes = probe.writes;
    labels = [...probe.labels];
    after = jointState(realDb!, sc);
  });

  it("C4 PRECONDITION: the clean run succeeds, writes, and changes state", () => {
    expect({ success: clean.success, error: clean.error ?? null }).toEqual({ success: true, error: null });
    expect(writes).toBeGreaterThan(0);
    expect(after).not.toEqual(before);
  });

  it("C1 crash sweep: the JOINT committed state around every statement is BEFORE or AFTER", async () => {
    if (!clean.success) throw new Error(`sweep not run: clean run failed: ${clean.error}`);
    const violations: string[] = [];
    let fired = 0;
    for (let n = 1; n <= total; n++) {
      openFresh();
      sc.seed(realDb!);
      resetProbe();
      probe.snapshotAt = n;
      probe.snapshotFn = () => jointState(observer!, sc);
      await runImport(sc);
      if (probe.pre !== null && probe.post !== null) fired++;
      if (probe.pre !== before && probe.pre !== after) violations.push(`before #${n} (${labels[n - 1]})`);
      if (probe.post !== before && probe.post !== after) violations.push(`after #${n} (${labels[n - 1]})`);
    }
    expect(fired).toBe(total);
    expect(violations).toEqual([]);
  });

  it("C2 error sweep: every statement fails once; BEFORE => failure, success => AFTER, never HALF", async () => {
    if (!clean.success) throw new Error(`sweep not run: clean run failed: ${clean.error}`);
    const violations: string[] = [];
    let ran = 0;
    for (let n = 1; n <= total; n++) {
      openFresh();
      sc.seed(realDb!);
      resetProbe();
      probe.throwAt = n;
      const res = await runImport(sc);
      ran++;
      const fin = jointState(realDb!, sc);
      const shape = fin === before ? "BEFORE" : fin === after ? "AFTER" : "HALF";
      if (shape === "HALF" || (shape === "BEFORE" && res.success !== false) || (res.success === true && shape !== "AFTER")) {
        violations.push(`#${n} (${labels[n - 1]}) success=${res.success} ${shape}`);
      }
    }
    expect(ran).toBe(total);
    expect(violations).toEqual([]);
  });
});
