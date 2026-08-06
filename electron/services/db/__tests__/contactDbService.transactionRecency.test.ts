/**
 * @jest-environment node
 *
 * BACKLOG-2357 — the TRANSACTION-flow recency path (Add Contacts / audit wizard)
 * loads contacts via `getContactsSortedByActivity`, whose recency was
 * `COALESCE(c.last_inbound_at, c.last_outbound_at)` — the denormalized columns
 * that are backfilled from PHONE/SMS/iMessage ONLY (never email). So a
 * freshly-imported EMAIL-ONLY contact read NULL there, and on select->import its
 * date flipped real->null and the row dropped to the alphabetical tail = the
 * founder's select-jump (Paul, Daniel).
 *
 * Fix A swaps that expression for the SHARED `IMPORTED_CONTACT_LAST_COMMUNICATION_SQL`
 * fragment (phone + email + denormalized). These tests run the REAL
 * `getContactsSortedByActivity` against an in-memory better-sqlite3 database (the
 * mocked-dbConnection unit tests can't execute SQL) and assert:
 *   1. an email-only imported contact surfaces its REAL email date (was NULL),
 *   2. the ANTI-JUMP INVARIANT on THIS path: the transaction path's imported
 *      recency == the external path's recency for the SAME person, so importing
 *      changes nothing to sort on.
 *
 * dbConnection is mocked to delegate straight to the in-memory DB; only the
 * one-shot "has backfill ever run" COUNT is stubbed truthy so the phone-only
 * backfill (irrelevant here) never runs.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import crypto from "crypto";

// dbConnection delegates to the live in-memory DB assigned in beforeEach.
const mockDbGet = jest.fn();
const mockDbAll = jest.fn();
const mockDbRun = jest.fn();
const mockDbTransaction = jest.fn((fn: () => unknown) => fn());

jest.mock("../core/dbConnection", () => ({
  dbGet: mockDbGet,
  dbAll: mockDbAll,
  dbRun: mockDbRun,
  dbTransaction: mockDbTransaction,
}));

jest.mock("../../logService", () => ({
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

jest.mock("../../contactsService", () => ({
  getContactNames: jest.fn(),
}));

jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: () => false,
}));

jest.mock("../../../schemas", () => ({
  ContactSchema: {},
  validateResponse: (_schema: unknown, data: unknown) => data,
}));

import { getContactsSortedByActivity } from "../contactDbService";
import { EXTERNAL_CONTACTS_GET_ALL_SQL } from "../contactRecencySql";

const USER_ID = "user-1";

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT,
      company TEXT,
      source TEXT,
      is_imported INTEGER DEFAULT 0,
      last_inbound_at DATETIME,
      last_outbound_at DATETIME,
      -- Migration v56 tombstone columns. Present because the activity-sorted
      -- picker now filters removed contacts (BACKLOG-2365). Every fixture row
      -- leaves them NULL = active, so these assertions are unaffected.
      removed_at DATETIME,
      removed_reason TEXT
    );

    CREATE TABLE contact_phones (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      phone_normalized TEXT,
      is_primary INTEGER DEFAULT 0
    );

    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0
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

    -- getMessageDerivedContacts queries this; empty -> no message-derived rows.
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      participants TEXT,
      sent_at DATETIME,
      associated_message_type INTEGER
    );

    -- external path (EXTERNAL_CONTACTS_GET_ALL_SQL) for the anti-jump comparison.
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
      -- BACKLOG-2401: ZEXTERNALUUID capture, added by migration v57 and
      -- selected by EXTERNAL_CONTACTS_GET_ALL_SQL. Declared here because
      -- this fixture hand-rolls the table instead of running the chain.
      external_uuid TEXT
    );
  `);
}

function insertEmail(db: DatabaseType, address: string, sentAt: string): void {
  const emailId = crypto.randomUUID();
  db.prepare("INSERT INTO emails (id, user_id, sent_at, received_at) VALUES (?, ?, ?, NULL)").run(
    emailId, USER_ID, sentAt,
  );
  db.prepare(
    "INSERT INTO email_participants (email_id, role, position, email_address) VALUES (?, 'from', 0, ?)",
  ).run(emailId, address);
}

/** An imported contacts row + its child email/phone rows (fresh import: denorm cols NULL). */
function insertImported(
  db: DatabaseType,
  opts: { id: string; name: string; emails?: string[]; phonesE164?: string[] },
): void {
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, 'manual', 1)",
  ).run(opts.id, USER_ID, opts.name);
  (opts.emails ?? []).forEach((email, i) => {
    db.prepare(
      "INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, ?)",
    ).run(crypto.randomUUID(), opts.id, email, i === 0 ? 1 : 0);
  });
  (opts.phonesE164 ?? []).forEach((phone, i) => {
    const normalized = phone.replace(/\D/g, "").slice(-10);
    db.prepare(
      "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary) VALUES (?, ?, ?, ?, ?)",
    ).run(crypto.randomUUID(), opts.id, phone, normalized, i === 0 ? 1 : 0);
  });
}

function insertExternal(
  db: DatabaseType,
  opts: { id: string; name: string; emails?: string[]; phonesNormalized?: string[] },
): void {
  db.prepare(
    `INSERT INTO external_contacts
       (id, user_id, name, emails_json, phones_normalized_json, source, external_record_id, synced_at)
     VALUES (?, ?, ?, ?, ?, 'macos', ?, '2026-01-01T00:00:00Z')`,
  ).run(
    opts.id,
    USER_ID,
    opts.name,
    opts.emails ? JSON.stringify(opts.emails) : null,
    opts.phonesNormalized ? JSON.stringify(opts.phonesNormalized) : null,
    opts.id,
  );
}

/** external path recency for one id, via the shared load query. */
function externalRecency(db: DatabaseType, id: string): string | null {
  const rows = db.prepare(EXTERNAL_CONTACTS_GET_ALL_SQL).all(USER_ID) as {
    id: string;
    last_message_at: string | null;
  }[];
  return rows.find((r) => r.id === id)?.last_message_at ?? null;
}

describe("getContactsSortedByActivity — transaction-flow recency (BACKLOG-2357, real SQLite)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    jest.clearAllMocks();
    db = new Database(":memory:");
    createSchema(db);

    mockDbGet.mockImplementation((sql: string, params: unknown[] = []) => {
      // Skip the one-shot phone-only backfill: pretend it has already run.
      if (typeof sql === "string" && sql.includes("last_inbound_at IS NOT NULL")) {
        return { count: 5 };
      }
      return db.prepare(sql).get(...(params ?? []));
    });
    mockDbAll.mockImplementation((sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params ?? [])),
    );
    mockDbRun.mockImplementation((sql: string, params: unknown[] = []) => {
      const r = db.prepare(sql).run(...(params ?? []));
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    });
  });

  afterEach(() => {
    db.close();
  });

  it("surfaces the EMAIL date for an email-only imported contact (was NULL)", async () => {
    // The founder's case: an email-only person with a real email but no SMS.
    insertEmail(db, "hd@berkeley.edu", "2026-05-01T10:00:00Z");
    insertImported(db, { id: "imp-hd", name: "Daniel Haim", emails: ["hd@berkeley.edu"] });

    const result = await getContactsSortedByActivity(USER_ID);

    const byId = new Map(result.map((c) => [c.id, c.last_communication_at]));
    expect(new Set(byId.keys())).toEqual(new Set(["imp-hd"]));
    // Pre-fix this was null (denorm columns are phone-only) -> select-jump.
    expect(byId.get("imp-hd")).toBe("2026-05-01T10:00:00Z");
  });

  it("ANTI-JUMP INVARIANT: transaction-path imported recency == external-path recency (email-only)", async () => {
    insertEmail(db, "hd@berkeley.edu", "2026-05-01T10:00:00Z");
    // The pre-import external twin AND the just-imported contact for the same person.
    insertExternal(db, { id: "ext-hd", name: "Daniel Haim", emails: ["hd@berkeley.edu"] });
    insertImported(db, { id: "imp-hd", name: "Daniel Haim", emails: ["hd@berkeley.edu"] });

    const imported = await getContactsSortedByActivity(USER_ID);
    const importedRecency = imported.find((c) => c.id === "imp-hd")?.last_communication_at ?? null;
    const external = externalRecency(db, "ext-hd");

    expect(importedRecency).toBe("2026-05-01T10:00:00Z");
    expect(external).toBe("2026-05-01T10:00:00Z");
    // The invariant that kills the jump: identical across paths, so select->import
    // does not change what the row sorts on.
    expect(importedRecency).toBe(external);
  });

  it("takes the MAX across phone and email on the transaction path too", async () => {
    insertEmail(db, "both@x.com", "2026-06-01T00:00:00Z"); // email newer
    insertImported(db, {
      id: "imp-both",
      name: "Both Channels",
      emails: ["both@x.com"],
      phonesE164: ["+14155550109"],
    });
    // Phone message OLDER than the email; email should win.
    db.prepare(
      "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)",
    ).run("4155550109", USER_ID, "2026-01-01T00:00:00Z");

    const result = await getContactsSortedByActivity(USER_ID);
    expect(result.find((c) => c.id === "imp-both")?.last_communication_at).toBe(
      "2026-06-01T00:00:00Z",
    );
  });

  it("still returns NULL for a contact with no phone and no email activity", async () => {
    insertImported(db, { id: "imp-cold", name: "Never Contacted", emails: ["cold@x.com"] });

    const result = await getContactsSortedByActivity(USER_ID);
    expect(result.find((c) => c.id === "imp-cold")?.last_communication_at).toBeNull();
  });
});
