/**
 * BACKLOG-4180 fix 1a — the address-book read dedupes phones from the STORED
 * lookup keys (`phones_normalized_json`) instead of running libphonenumber on
 * every phone of every row on every read.
 *
 * Every row here is written by the REAL writer (`upsertFromMacOS`), so the
 * stored keys are what production stores, not a hand-written array.
 *
 * Fixtures are fictional: 415 555-01xx numbers and example.test addresses.
 *
 * Controls:
 *   C1 alignment     keys line up with the KEPT phones, not raw indexes
 *                    (leading blank, and a JSON null — DEFENSIVE: no provider
 *                    is known to emit a null phone; a blank is emittable, the
 *                    macOS reader filters ZFULLNUMBER only on IS NOT NULL)
 *   C2 display values out, never keys
 *   C3 fallback      NULL / bad JSON / short array -> same as dedupePhoneValues
 *   C4 no libphonenumber on the read, sync and worker-pool paths, and no writes
 */

import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;
let mockPoolReady = false;
const mockQueryContacts = jest.fn();

jest.mock("../core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../../../workers/contactWorkerPool", () => ({
  isPoolReady: () => mockPoolReady,
  queryContacts: (...args: unknown[]) => mockQueryContacts(...args),
}));

jest.mock("../../contactIngestionFunnel", () => ({
  recordShadowSync: jest.fn(),
}));

jest.mock("../../contactLinkingScheduler", () => ({
  requestContactLinking: jest.fn(),
}));

import * as phoneNormalization from "../../../utils/phoneNormalization";
import { dedupePhoneValues, dedupePhoneValuesWithKeys } from "../../../utils/contactValueDedup";
import { getAllForUser, getAllForUserAsync, upsertFromMacOS } from "../externalContactDbService";
import { EXTERNAL_CONTACTS_GET_ALL_SQL } from "../contactRecencySql";

const USER_ID = "user-4180";

function createSchema(db: TestDb): void {
  db.exec(`
    CREATE TABLE external_contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT,
      phones_json TEXT,
      phones_normalized_json TEXT,
      emails_json TEXT,
      company TEXT,
      last_message_at DATETIME,
      external_record_id TEXT,
      source TEXT,
      synced_at DATETIME,
      external_uuid TEXT,
      source_identity_json TEXT,
      UNIQUE(user_id, source, external_record_id)
    );
    CREATE TABLE phone_last_message (
      phone_normalized TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_message_at DATETIME NOT NULL,
      PRIMARY KEY (phone_normalized, user_id)
    );
    CREATE TABLE emails (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, sent_at DATETIME, received_at DATETIME);
    CREATE TABLE email_participants (
      email_id TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL, email_address TEXT NOT NULL,
      PRIMARY KEY (email_id, role, position)
    );
  `);
}

beforeEach(() => {
  mockDb = openTestDb(":memory:");
  createSchema(mockDb);
  mockPoolReady = false;
  mockQueryContacts.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
  mockDb?.close();
  mockDb = null;
});

function phonesOf(name: string): string[] {
  const row = getAllForUser(USER_ID).find((c) => c.name === name);
  if (!row) throw new Error(`no external contact named ${name}`);
  return row.phones;
}

function storedKeysOf(recordId: string): unknown {
  const row = mockDb!
    .prepare("SELECT phones_normalized_json AS k FROM external_contacts WHERE external_record_id = ?")
    .get(recordId) as { k: string | null };
  return row.k === null ? null : JSON.parse(row.k);
}

describe("BACKLOG-4180 C1 — stored keys align with the kept phones, not raw indexes", () => {
  it("leading blank: output equals dedupePhoneValues", () => {
    const phones = ["  ", "(415) 555-0106", "+1 415 555 0106", "415-555-0107"];
    upsertFromMacOS(USER_ID, [{ name: "Quill Blank", phones, emails: [], recordId: "r-blank" }]);

    // The writer dropped the blank: three keys for four raw values.
    expect((storedKeysOf("r-blank") as string[]).length).toBe(3);
    expect(phonesOf("Quill Blank")).toEqual(["(415) 555-0106", "415-555-0107"]);
    expect(phonesOf("Quill Blank")).toEqual(dedupePhoneValues(phones));
  });

  it("leading JSON null (DEFENSIVE): output equals dedupePhoneValues", () => {
    const phones = [null, "(415) 555-0106", "+1 415 555 0106", "415-555-0107"] as unknown as string[];
    upsertFromMacOS(USER_ID, [{ name: "Quill Null", phones, emails: [], recordId: "r-null" }]);

    expect((storedKeysOf("r-null") as string[]).length).toBe(3);
    expect(phonesOf("Quill Null")).toEqual(["(415) 555-0106", "415-555-0107"]);
  });

  it("no blanks: distinct numbers survive, duplicates collapse, first spelling kept", () => {
    const phones = [" 415.555.0108 ", "4155550108", "415-555-0109"];
    upsertFromMacOS(USER_ID, [{ name: "Quill Plain", phones, emails: [], recordId: "r-plain" }]);
    expect(phonesOf("Quill Plain")).toEqual(["415.555.0108", "415-555-0109"]);
  });
});

describe("BACKLOG-4180 C2 — display values out, never keys", () => {
  it("returns the trimmed address-book spelling, not the stored key", () => {
    upsertFromMacOS(USER_ID, [
      { name: "Quill Display", phones: ["(415) 555-0110"], emails: [], recordId: "r-disp" },
    ]);
    expect(storedKeysOf("r-disp")).toEqual(["14155550110"]);
    expect(phonesOf("Quill Display")).toEqual(["(415) 555-0110"]);
  });
});

describe("BACKLOG-4180 C3 — anything but a matching key array falls back", () => {
  const phones = ["(415) 555-0111", "+1 415 555 0111", "415-555-0112"];
  const expected = dedupePhoneValues(phones);

  it.each([
    ["NULL", null],
    ["short array", JSON.stringify(["14155550111"])],
    ["long array", JSON.stringify(["14155550111", "14155550111", "14155550112", "x"])],
    ["non-string entries", JSON.stringify([1, 2, 3])],
  ])("%s -> same output as dedupePhoneValues", (_label, stored) => {
    upsertFromMacOS(USER_ID, [{ name: "Quill Fallback", phones, emails: [], recordId: "r-fb" }]);
    mockDb!
      .prepare("UPDATE external_contacts SET phones_normalized_json = ? WHERE external_record_id = 'r-fb'")
      .run(stored);
    expect(phonesOf("Quill Fallback")).toEqual(expected);
  });

  // Malformed JSON in the column cannot reach the mapper through this read: the
  // inline recency expression already runs json_each over the column, and SQLite
  // rejects the whole query ("malformed JSON") — true before this change too.
  // The mapper's own guard is therefore proven on the pure function.
  it("the pure function: a non-array (what a failed parse yields) falls back", () => {
    expect(dedupePhoneValuesWithKeys(phones, null)).toEqual(expected);
    expect(dedupePhoneValuesWithKeys(phones, "not json")).toEqual(expected);
  });

  it("the pure function: short key array falls back rather than zipping", () => {
    // A zip of a short array would drop "415-555-0112" or mis-key it.
    expect(dedupePhoneValuesWithKeys(phones, ["14155550111"])).toEqual(expected);
  });
});

describe("BACKLOG-4180 C4 — the read runs no libphonenumber and writes nothing", () => {
  function seed100(): void {
    const contacts = Array.from({ length: 100 }, (_, i) => ({
      name: `Quill ${i}`,
      phones: [`(415) 555-01${String(i % 100).padStart(2, "0")}`, `+1 415 555 01${String(i % 100).padStart(2, "0")}`],
      emails: [`q${i}@example.test`],
      recordId: `r-${i}`,
    }));
    upsertFromMacOS(USER_ID, contacts);
  }

  it("sync path (pool not ready): 0 toLookupKey calls, 0 writes, 100 rows", () => {
    seed100();
    const spy = jest.spyOn(phoneNormalization, "toLookupKey");
    const changesBefore = (mockDb!.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

    const rows = getAllForUser(USER_ID);

    expect(rows).toHaveLength(100);
    expect(rows.every((r) => r.phones.length === 1)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(0);
    const changesAfter = (mockDb!.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    expect(changesAfter).toBe(changesBefore);
  });

  it("worker path (pool ready): rows from the production SQL, 0 toLookupKey calls", async () => {
    seed100();
    // The worker runs EXTERNAL_CONTACTS_GET_ALL_SQL verbatim (contactQueryWorker.ts).
    const workerRows = mockDb!.prepare(EXTERNAL_CONTACTS_GET_ALL_SQL).all(USER_ID);
    mockPoolReady = true;
    mockQueryContacts.mockResolvedValue(workerRows);
    const spy = jest.spyOn(phoneNormalization, "toLookupKey");

    const rows = await getAllForUserAsync(USER_ID);

    expect(mockQueryContacts).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(100);
    expect(rows.every((r) => r.phones.length === 1)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(0);
  });
});
