/**
 * @jest-environment node
 *
 * BACKLOG-2391 — `fullSync` must report inserted / updated / unchanged as three
 * genuinely different numbers.
 *
 * It previously could not, and said so in its own source:
 *
 *     inserted: upsertCount,  // This is actually upsert count (insert or update)
 *     updated: 0,             // We can't distinguish easily with UPSERT
 *
 * The visible consequence in a real user's log was `Upserted 716 external
 * contacts from macOS` on every single sync — a number that is identical
 * whether 716 contacts were newly discovered or nothing at all changed. The
 * same lie reached the UI, which renders `inserted` as "N new contacts added".
 *
 * These tests run the REAL `fullSync` against a REAL in-memory better-sqlite3
 * database (same harness as externalContactDbService.staleDeleteScope.test.ts):
 * `./core/dbConnection` is mocked with thin delegates over a live connection so
 * the service's actual SQL executes, and the driver is required by absolute
 * path to bypass the jest.config.js `moduleNameMapper` stub.
 *
 * ASSERTION STYLE: exact ID SETS wherever identity matters. `inserted: 1` is
 * equally satisfied by inserting the WRONG record.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

// Live connection shared with the dbConnection mock below.
// Must be named `mock*` to satisfy babel-plugin-jest-hoist's out-of-scope rule.
let mockDb: DatabaseType | null = null;

const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();

jest.mock("../core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...params);
    return { lastInsertRowid: r.lastInsertRowid as number, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn().mockReturnValue(false),
}));

jest.mock("../../logService", () => ({
  __esModule: true,
  default: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { fullSync, type MacOSContact } from "../externalContactDbService";
import {
  getContactIngestionFunnel,
  resetContactIngestionFunnel,
} from "../../contactIngestionFunnel";

const USER_ID = "user-2391";

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY);

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
      source TEXT DEFAULT 'macos',
      synced_at DATETIME,
      sync_session_id TEXT,
      -- BACKLOG-2401: ZEXTERNALUUID capture. Added by migration v57; declared
      -- here because these fixtures hand-roll the table rather than run the
      -- chain, and the macOS upsert now writes this column.
      external_uuid TEXT,
      UNIQUE(user_id, source, external_record_id)
    );

    CREATE TABLE phone_last_message (
      phone_normalized TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_message_at DATETIME NOT NULL,
      PRIMARY KEY (phone_normalized, user_id)
    );

    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      sent_at DATETIME,
      received_at DATETIME
    );

    CREATE TABLE email_participants (
      email_id TEXT NOT NULL,
      role TEXT NOT NULL,
      position INTEGER NOT NULL,
      email_address TEXT NOT NULL,
      PRIMARY KEY (email_id, role, position)
    );
    CREATE INDEX idx_email_participants_email_address ON email_participants(email_address);
  `);
}

/** A small, fully-known address book. */
const BOOK: MacOSContact[] = [
  { name: "Alice Anderson", recordId: "rec-1", phones: ["+15551110001"], emails: ["alice@example.com"] },
  { name: "Bob Brown", recordId: "rec-2", phones: ["+15551110002"], emails: [] },
  { name: "Carol Carter", recordId: "rec-3", phones: [], emails: ["carol@example.com"] },
];

/** Exact record ids stored for a source, sorted — identity, not count. */
function recordIdsOfSource(source = "macos"): string[] {
  return (
    mockDb!
      .prepare(
        "SELECT external_record_id FROM external_contacts WHERE user_id = ? AND source = ? ORDER BY external_record_id"
      )
      .all(USER_ID, source) as Array<{ external_record_id: string }>
  ).map((r) => r.external_record_id);
}

/**
 * Backdate every stored row so the next `fullSync` sees them as previously
 * synced. `deleteStaleContactsBySource` compares `synced_at < syncStartTime` on
 * millisecond ISO strings, so two syncs inside the same millisecond would
 * delete nothing — real syncs are hours apart, and this reproduces that without
 * making the test depend on wall-clock timing.
 */
function ageStoredRows(): void {
  mockDb!
    .prepare("UPDATE external_contacts SET synced_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?")
    .run(USER_ID);
}

/** Every string this suite has logged, joined — for the PII assertion. */
function emittedLogText(): string {
  return [...mockLogInfo.mock.calls, ...mockLogWarn.mock.calls]
    .map((c) => c.map((a: unknown) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    .join("\n");
}

describe("BACKLOG-2391: fullSync distinguishes inserted / updated / unchanged", () => {
  beforeEach(() => {
    mockDb = new Database(":memory:") as DatabaseType;
    createSchema(mockDb);
    mockDb.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    mockLogInfo.mockClear();
    mockLogWarn.mockClear();
    resetContactIngestionFunnel();
  });

  afterEach(() => {
    mockDb?.close();
    mockDb = null;
  });

  it("counts a first sync as all inserts, nothing updated or unchanged", () => {
    const result = fullSync(USER_ID, BOOK);

    expect(result.inserted).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.deleted).toBe(0);

    // Identity: the three inserted rows are the three we handed over.
    expect(recordIdsOfSource()).toEqual(["rec-1", "rec-2", "rec-3"]);
  });

  it("a SECOND sync over identical data reports unchanged — NOT inserts", () => {
    fullSync(USER_ID, BOOK);
    const second = fullSync(USER_ID, BOOK);

    // This is the whole point of the ticket. Before the fix this was
    // `inserted: 3, updated: 0` on every repeat sync, forever.
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(3);
    expect(second.deleted).toBe(0);

    // And no row was duplicated or lost by the re-sync.
    expect(recordIdsOfSource()).toEqual(["rec-1", "rec-2", "rec-3"]);
  });

  it("separates a genuinely changed record from the untouched ones", () => {
    fullSync(USER_ID, BOOK);

    const edited: MacOSContact[] = [
      BOOK[0],
      // Bob gained a second phone in the Mac address book.
      { ...BOOK[1], phones: ["+15551110002", "+15558880002"] },
      BOOK[2],
    ];
    const second = fullSync(USER_ID, edited);

    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(2);

    // Identity: the row that changed is Bob's, and it really did change.
    const bob = mockDb!
      .prepare(
        "SELECT phones_json FROM external_contacts WHERE user_id = ? AND source = 'macos' AND external_record_id = 'rec-2'"
      )
      .get(USER_ID) as { phones_json: string };
    expect(JSON.parse(bob.phones_json)).toEqual(["+15551110002", "+15558880002"]);
  });

  it("counts a rename as an update, not an insert", () => {
    fullSync(USER_ID, BOOK);

    const renamed: MacOSContact[] = [
      { ...BOOK[0], name: "Alice Anderson-Smith" },
      BOOK[1],
      BOOK[2],
    ];
    const second = fullSync(USER_ID, renamed);

    expect(second).toMatchObject({ inserted: 0, updated: 1, unchanged: 2 });
    // Same record id, so no new row: 3 rows, not 4.
    expect(recordIdsOfSource()).toEqual(["rec-1", "rec-2", "rec-3"]);
  });

  it("splits a mixed sync into all four numbers at once", () => {
    fullSync(USER_ID, BOOK);
    ageStoredRows();

    const next: MacOSContact[] = [
      BOOK[0],                                                     // unchanged
      { ...BOOK[1], company: "Brown & Co" },                       // updated
      // BOOK[2] (rec-3) removed from the Mac                      -> deleted
      { name: "Dave Davis", recordId: "rec-4", phones: ["+15551110004"], emails: [] }, // inserted
    ];
    const second = fullSync(USER_ID, next);

    expect(second.inserted).toBe(1);
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(1);
    expect(second.deleted).toBe(1);

    // Identity: rec-3 is gone, rec-4 arrived, rec-1/rec-2 survived in place.
    expect(recordIdsOfSource()).toEqual(["rec-1", "rec-2", "rec-4"]);
  });

  it("does not double-count a record id repeated inside ONE payload", () => {
    // Two rows with the same recordId collapse via ON CONFLICT into one stored
    // row. Counting them as two inserts would overstate what happened.
    const result = fullSync(USER_ID, [
      BOOK[0],
      { ...BOOK[0], name: "Alice A." },
    ]);

    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(recordIdsOfSource()).toEqual(["rec-1"]);
  });

  it("ignores other sources when classifying — a matching Outlook record is not 'existing'", () => {
    // Same external_record_id under a DIFFERENT source. The macOS row does not
    // exist yet, so it is an INSERT; reading the record-id set unscoped would
    // wrongly call it unchanged.
    mockDb!
      .prepare(
        `INSERT INTO external_contacts
           (id, user_id, name, phones_json, phones_normalized_json, emails_json, company,
            external_record_id, source, synced_at)
         VALUES ('ext-outlook-1', ?, 'Alice Anderson', '["+15551110001"]', '["5551110001"]',
                 '["alice@example.com"]', NULL, 'rec-1', 'outlook', '2020-01-01T00:00:00.000Z')`
      )
      .run(USER_ID);

    const result = fullSync(USER_ID, [BOOK[0]]);

    expect(result.inserted).toBe(1);
    expect(result.unchanged).toBe(0);
    // The Outlook row is untouched (BACKLOG-2385 scoping still holds).
    expect(recordIdsOfSource("outlook")).toEqual(["rec-1"]);
  });

  it("ignores another user's rows when classifying", () => {
    mockDb!.prepare("INSERT INTO users_local (id) VALUES ('user-other')").run();
    mockDb!
      .prepare(
        `INSERT INTO external_contacts
           (id, user_id, name, phones_json, phones_normalized_json, emails_json, company,
            external_record_id, source, synced_at)
         VALUES ('ext-other-1', 'user-other', 'Alice Anderson', '["+15551110001"]', '["5551110001"]',
                 '["alice@example.com"]', NULL, 'rec-1', 'macos', '2020-01-01T00:00:00.000Z')`
      )
      .run();

    expect(fullSync(USER_ID, [BOOK[0]]).inserted).toBe(1);
  });

  it("reports the same numbers through the structured funnel snapshot", () => {
    fullSync(USER_ID, BOOK);
    const second = fullSync(USER_ID, [
      BOOK[0],
      { ...BOOK[1], company: "Brown & Co" },
      BOOK[2],
    ]);

    const shadow = getContactIngestionFunnel().shadowSync;
    expect(shadow).toBeDefined();
    expect(shadow).toMatchObject({
      source: "macos",
      inserted: second.inserted,
      updated: second.updated,
      unchanged: second.unchanged,
      deleted: second.deleted,
      total: second.total,
    });
  });

  it("logs one funnel line naming the source, with the real numbers", () => {
    fullSync(USER_ID, BOOK);
    mockLogInfo.mockClear();
    fullSync(USER_ID, BOOK);

    const shadowLines = mockLogInfo.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("shadow:"));

    expect(shadowLines).toEqual([
      "[ExternalContactDbService] shadow: inserted 0, updated 0, unchanged 3," +
        " deleted 0 (source=macos), total 3",
    ]);
  });

  it("leaks no contact name, email or phone number into any log line", () => {
    fullSync(USER_ID, [
      ...BOOK,
      // A multi-email contact: this is exactly the row that used to trigger a
      // per-contact `[DIAG-1270] Shadow WRITE: <name> → <every address>` warn.
      {
        name: "Erin Evans",
        recordId: "rec-5",
        phones: ["+15551110005"],
        emails: ["erin@example.com", "erin.evans@work.example.com"],
      },
    ]);

    const emitted = emittedLogText();
    expect(emitted).not.toBe("");

    for (const secret of [
      "Alice Anderson", "Bob Brown", "Carol Carter", "Erin Evans",
      "alice@example.com", "carol@example.com", "erin@example.com",
      "erin.evans@work.example.com",
      "+15551110001", "+15551110002", "+15551110005",
    ]) {
      expect(emitted).not.toContain(secret);
    }
  });
});
