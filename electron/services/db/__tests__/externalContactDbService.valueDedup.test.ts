/**
 * @jest-environment node
 *
 * BACKLOG-2457 — a contact's card in the import picker listed one mailbox twice,
 * because the source record carried it under two field types.
 *
 * ===========================================================================
 * THE QUESTION THIS SUITE EXISTS TO SETTLE
 * ===========================================================================
 * "The card draws it twice" and "the contact HOLDS it twice" are different
 * defects with different blast radii. If the duplicate survives into
 * `contact_emails`, then every reader of that table carries it too — including
 * `getContactEmailsForTransaction`, which is what the transaction email sweep
 * searches on. A display fix would then be a cosmetic patch over a data bug.
 *
 * So this suite does NOT stop at the picker's output. It drives the SAME array
 * the picker hands to the import (`allEmails`) through the REAL write paths —
 * `createContactsBatch` (new contact) and `backfillContactEmailsSync` (existing
 * contact) — against the REAL `UNIQUE(contact_id, email)` /
 * `UNIQUE(contact_id, phone_e164)` constraints, and reads `contact_emails` back.
 *
 * The answer it records, by execution: the write layer already collapses
 * case-folded repeats, so the duplicate NEVER reached the database. The defect
 * is display-only — and the tests below are what makes that a finding rather
 * than an assumption. `undedupedImportReachesOneRow` is deliberately fed the RAW
 * duplicated array, not the fixed picker output, so it keeps proving that even
 * if the read-side collapse is later removed.
 *
 * ===========================================================================
 * ASSERTION STYLE — EXACT VALUE SETS, NEVER COUNTS
 * ===========================================================================
 * `toHaveLength(1)` is equally satisfied by keeping the WRONG address. Every
 * assertion below names the exact array or set it expects.
 *
 * ===========================================================================
 * FIXTURES ARE FICTIONAL (BACKLOG-2485) — DO NOT "IMPROVE" THEM WITH REAL DATA
 * ===========================================================================
 * This bug was reported against a real person in the founder's address book, so
 * the tempting fixture is that record verbatim. This repository is PUBLIC: a
 * contact's name, mailbox and mobile number are that third party's personal
 * data, and publishing it here would be the product failing at the one thing it
 * exists to do. Every value below is from a range reserved so it cannot collide
 * with anyone real — `example.test` / `example.com` (RFC 2606) and `555-01xx`
 * numbers — with invented names. What the defect needs is one value repeated on
 * one record; whose value it was never mattered.
 *
 * ===========================================================================
 * ENGINE
 * ===========================================================================
 * Real SQL on a real engine via the shared `openTestDb` helper — better-sqlite3
 * where it loads (CI), `node:sqlite` on a dev machine whose shared binary is an
 * Electron build. See `electron/services/__tests__/helpers/syncSqliteDriver.ts`.
 */

import { openTestDb, currentEngine, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";

// Must be named `mock*` to satisfy babel-plugin-jest-hoist's out-of-scope rule.
let mockDb: TestDb | null = null;

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
  dbTransaction: <T>(fn: () => T): T => {
    mockDb!.exec("BEGIN");
    try {
      const out = fn();
      mockDb!.exec("COMMIT");
      return out;
    } catch (e) {
      mockDb!.exec("ROLLBACK");
      throw e;
    }
  },
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

// The worker pool is an optimisation with a sync fallback; these suites take the
// fallback so the assertions run against SQL and not a mocked worker reply.
jest.mock("../../../workers/contactWorkerPool", () => ({
  isPoolReady: () => false,
  queryContacts: jest.fn(),
}));

jest.mock("../../contactIngestionFunnel", () => ({
  recordShadowSync: jest.fn(),
}));

import { getAllForUser, search } from "../externalContactDbService";
import { createContactsBatch, backfillContactEmailsSync, backfillContactPhonesSync } from "../contactDbService";

const USER_ID = "user-1";

/**
 * The columns EXTERNAL_CONTACTS_GET_ALL_SQL selects and the junction tables with
 * their REAL uniqueness constraints (copied from electron/database/schema.sql —
 * the constraint is half of what is under test, so a fixture without it would
 * prove nothing).
 */
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
      external_uuid TEXT
    );

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT,
      company TEXT,
      title TEXT,
      source TEXT,
      is_imported INTEGER DEFAULT 0
    );

    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0,
      label TEXT,
      source TEXT CHECK (source IN ('import', 'manual', 'inferred')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(contact_id, email)
    );

    CREATE TABLE contact_phones (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      phone_display TEXT,
      phone_normalized TEXT,
      is_primary INTEGER DEFAULT 0,
      label TEXT,
      source TEXT CHECK (source IN ('import', 'manual', 'inferred')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(contact_id, phone_e164)
    );

    -- Referenced by the inline recency expression in EXTERNAL_CONTACTS_GET_ALL_SQL.
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
  `);
}

/** One shadow row, exactly as a provider sync would have written it. */
function seedSourceRecord(opts: {
  recordId: string;
  name: string;
  emails: string[];
  phones?: string[];
  source?: string;
}): void {
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
         (id, user_id, name, phones_json, phones_normalized_json, emails_json,
          company, external_record_id, source, synced_at)
       VALUES (?, ?, ?, ?, '[]', ?, NULL, ?, ?, '2026-08-04T00:00:00Z')`,
    )
    .run(
      `ext-${opts.recordId}`,
      USER_ID,
      opts.name,
      JSON.stringify(opts.phones ?? []),
      JSON.stringify(opts.emails),
      opts.recordId,
      opts.source ?? "outlook",
    );
}

function emailsOf(name: string): string[] {
  const row = getAllForUser(USER_ID).find((c) => c.name === name);
  if (!row) throw new Error(`no external contact named ${name}`);
  return row.emails;
}

function phonesOf(name: string): string[] {
  const row = getAllForUser(USER_ID).find((c) => c.name === name);
  if (!row) throw new Error(`no external contact named ${name}`);
  return row.phones;
}

/** Every address stored against a contact, as `contact_emails` holds it. */
function storedEmails(contactId: string): string[] {
  return (
    mockDb!
      .prepare("SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY email")
      .all(contactId) as Array<{ email: string }>
  ).map((r) => r.email);
}

function storedPhones(contactId: string): string[] {
  return (
    mockDb!
      .prepare("SELECT phone_e164 FROM contact_phones WHERE contact_id = ? ORDER BY phone_e164")
      .all(contactId) as Array<{ phone_e164: string }>
  ).map((r) => r.phone_e164);
}

beforeEach(() => {
  mockDb = openTestDb();
  createSchema(mockDb);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe(`external contact value dedup [engine: ${currentEngine() ?? "resolved at first open"}]`, () => {
  // =========================================================================
  // WHAT THE CARD SHOWS
  // =========================================================================
  describe("the picker's view of one source record", () => {
    it("shows ONE row for a mailbox listed under two field types", () => {
      // The reported shape: Outlook `Email` and the chat field, both the same
      // address, both returned in Graph's single `emailAddresses` array.
      seedSourceRecord({
        recordId: "outlook-robin",
        name: "Robin Quillfeather",
        emails: ["quillfeather@example.test", "quillfeather@example.test"],
        phones: ["5555550142"],
      });

      expect(emailsOf("Robin Quillfeather")).toEqual(["quillfeather@example.test"]);
    });

    it("shows BOTH of two genuinely different addresses, in source order", () => {
      seedSourceRecord({
        recordId: "outlook-two",
        name: "Two Address",
        emails: ["work@example.test", "personal@example.com"],
      });

      expect(emailsOf("Two Address")).toEqual([
        "work@example.test",
        "personal@example.com",
      ]);
    });

    it("collapses case and trailing-whitespace variants onto the first spelling", () => {
      seedSourceRecord({
        recordId: "outlook-case",
        name: "Case Variant",
        emails: ["Robin@Example.test", "robin@example.test ", "  ROBIN@EXAMPLE.TEST"],
      });

      expect(emailsOf("Case Variant")).toEqual(["Robin@Example.test"]);
    });

    it("keeps a real second address that only LOOKS similar", () => {
      seedSourceRecord({
        recordId: "outlook-near",
        name: "Near Miss",
        emails: ["robin@example.test", "robin@example.com", "robins@example.test"],
      });

      expect(emailsOf("Near Miss")).toEqual([
        "robin@example.test",
        "robin@example.com",
        "robins@example.test",
      ]);
    });

    it("shows ONE row for one number carried under two labels", () => {
      // Graph flattens mobilePhone + homePhones + businessPhones into one array;
      // an Apple unified card carries the same number as `mobile` and `iPhone`.
      seedSourceRecord({
        recordId: "outlook-phone-dup",
        name: "Phone Dup",
        emails: [],
        phones: ["(555) 555-0142", "+1 555-555-0142", "5555550142"],
      });

      expect(phonesOf("Phone Dup")).toEqual(["(555) 555-0142"]);
    });

    it("shows BOTH of two genuinely different numbers", () => {
      seedSourceRecord({
        recordId: "outlook-phone-two",
        name: "Phone Two",
        emails: [],
        phones: ["5555550142", "(555) 555-0187"],
      });

      expect(phonesOf("Phone Two")).toEqual(["5555550142", "(555) 555-0187"]);
    });

    it("applies the same collapse on the search path as on the load path", () => {
      // A search hit renders the same card. Two readers disagreeing about how
      // many addresses a record has is how this defect returns by half.
      seedSourceRecord({
        recordId: "outlook-search",
        name: "Searchable Quillfeather",
        emails: ["quillfeather@example.test", "QUILLFEATHER@example.test"],
        phones: ["5555550142", "555-555-0142"],
      });

      const hit = search(USER_ID, "Quillfeather").find(
        (c) => c.name === "Searchable Quillfeather",
      );
      expect(hit?.emails).toEqual(["quillfeather@example.test"]);
      expect(hit?.phones).toEqual(["5555550142"]);
    });
  });

  // =========================================================================
  // WHAT REACHES THE DATABASE — the finding, not an assumption
  // =========================================================================
  describe("whether the duplicate survives into contact_emails", () => {
    it("createContactsBatch stores ONE row even when handed the RAW duplicate array", () => {
      // Fed the UNDEDUPED array on purpose: this is the picker's payload as it
      // was BEFORE the read-side collapse, so it keeps answering "is this a data
      // bug?" independently of the fix.
      const [contactId] = createContactsBatch([
        {
          user_id: USER_ID,
          display_name: "Robin Quillfeather",
          allEmails: ["quillfeather@example.test", "quillfeather@example.test"],
          allPhones: ["(555) 555-0142", "+1 555-555-0142"],
        },
      ]);

      expect(storedEmails(contactId)).toEqual(["quillfeather@example.test"]);
      expect(storedPhones(contactId)).toEqual(["+15555550142"]);
    });

    it("createContactsBatch stores ONE row for case/whitespace variants, lowercased", () => {
      const [contactId] = createContactsBatch([
        {
          user_id: USER_ID,
          display_name: "Case Variant",
          allEmails: ["Robin@Example.test", "robin@example.test ", "other@example.test"],
        },
      ]);

      expect(storedEmails(contactId)).toEqual(["other@example.test", "robin@example.test"]);
    });

    it("backfillContactEmailsSync stores ONE row from the RAW duplicate array", () => {
      // The other write path: an ALREADY-imported contact picking up a newly
      // linked source's values.
      mockDb!
        .prepare(
          "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)",
        )
        .run("contact-existing", USER_ID, "Robin Quillfeather");

      const added = backfillContactEmailsSync("contact-existing", [
        "quillfeather@example.test",
        "quillfeather@example.test",
        "QUILLFEATHER@EXAMPLE.TEST ",
      ]);

      expect(added).toBe(1);
      expect(storedEmails("contact-existing")).toEqual(["quillfeather@example.test"]);
    });

    it("backfillContactPhonesSync stores ONE row per number across spellings", () => {
      mockDb!
        .prepare(
          "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)",
        )
        .run("contact-phone", USER_ID, "Phone Dup");

      const added = backfillContactPhonesSync("contact-phone", [
        "(555) 555-0142",
        "+1 555-555-0142",
        "(555) 555-0187",
      ]);

      expect(added).toBe(2);
      expect(storedPhones("contact-phone")).toEqual([
        "+15555550142",
        "+15555550187",
      ]);
    });

    it("UNIQUE(contact_id, email) is the floor under EVERY writer, not just these two", () => {
      // `createContactsBatch` and `backfillContactEmailsSync` are the two import
      // writers this suite drives directly, but `contactQueryWorker` carries a
      // third copy of the same loop (the branch taken when the worker pool is
      // warm) and `createContact` a fourth. Rather than reproduce each, assert
      // the constraint they all insert THROUGH: even a writer that skipped its
      // own dedup entirely could not land the address twice.
      mockDb!
        .prepare(
          "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)",
        )
        .run("contact-floor", USER_ID, "Robin Quillfeather");

      const raw = `INSERT OR IGNORE INTO contact_emails (id, contact_id, email, is_primary, source)
                   VALUES (?, ?, ?, 0, 'import')`;
      mockDb!.prepare(raw).run("e1", "contact-floor", "quillfeather@example.test");
      const second = mockDb!
        .prepare(raw)
        .run("e2", "contact-floor", "quillfeather@example.test");

      expect(second.changes).toBe(0);
      expect(storedEmails("contact-floor")).toEqual(["quillfeather@example.test"]);

      const rawPhone = `INSERT OR IGNORE INTO contact_phones (id, contact_id, phone_e164, is_primary, source)
                        VALUES (?, ?, ?, 0, 'import')`;
      mockDb!.prepare(rawPhone).run("p1", "contact-floor", "+15555550142");
      const secondPhone = mockDb!
        .prepare(rawPhone)
        .run("p2", "contact-floor", "+15555550142");

      expect(secondPhone.changes).toBe(0);
      expect(storedPhones("contact-floor")).toEqual(["+15555550142"]);
    });

    it("re-importing the same source record adds nothing the second time", () => {
      mockDb!
        .prepare(
          "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)",
        )
        .run("contact-twice", USER_ID, "Robin Quillfeather");

      backfillContactEmailsSync("contact-twice", ["quillfeather@example.test"]);
      const secondPass = backfillContactEmailsSync("contact-twice", [
        "quillfeather@example.test",
        "quillfeather@example.test",
      ]);

      expect(secondPass).toBe(0);
      expect(storedEmails("contact-twice")).toEqual(["quillfeather@example.test"]);
    });
  });

  // =========================================================================
  // PICKER -> IMPORT, END TO END
  // =========================================================================
  describe("the whole journey: shadow row -> picker row -> contact_emails", () => {
    it("carries ONE address from a doubly-listed source record all the way in", () => {
      seedSourceRecord({
        recordId: "outlook-robin",
        name: "Robin Quillfeather",
        emails: ["quillfeather@example.test", "quillfeather@example.test"],
        phones: ["(555) 555-0142", "5555550142"],
      });

      // Exactly what `contacts:get-available` builds for the picker row.
      const record = getAllForUser(USER_ID)[0];
      const pickerRow = {
        email: record.emails[0] ?? null,
        phone: record.phones[0] ?? null,
        allEmails: record.emails,
        allPhones: record.phones,
      };

      // What the card renders.
      expect(pickerRow.allEmails).toEqual(["quillfeather@example.test"]);
      expect(pickerRow.allPhones).toEqual(["(555) 555-0142"]);
      // The primary is still the record's first-listed value.
      expect(pickerRow.email).toBe("quillfeather@example.test");
      expect(pickerRow.phone).toBe("(555) 555-0142");

      // What importing that row stores.
      const [contactId] = createContactsBatch([
        {
          user_id: USER_ID,
          display_name: record.name ?? "Unknown",
          allEmails: pickerRow.allEmails,
          allPhones: pickerRow.allPhones,
        },
      ]);

      expect(storedEmails(contactId)).toEqual(["quillfeather@example.test"]);
      expect(storedPhones(contactId)).toEqual(["+15555550142"]);
    });

    it("two distinct people keep two distinct address sets", () => {
      // The collapse is WITHIN a record. It must not reach across records — that
      // is BACKLOG-2416's job and answers to a different rule.
      seedSourceRecord({
        recordId: "rec-a",
        name: "Person A",
        emails: ["a@example.test", "a@example.test"],
      });
      seedSourceRecord({
        recordId: "rec-b",
        name: "Person B",
        emails: ["b@example.test"],
      });

      const byName = new Map(
        getAllForUser(USER_ID).map((c) => [c.name, c.emails]),
      );
      expect(byName.get("Person A")).toEqual(["a@example.test"]);
      expect(byName.get("Person B")).toEqual(["b@example.test"]);
      expect([...byName.keys()].sort()).toEqual(["Person A", "Person B"]);
    });
  });

  // =========================================================================
  // THINGS THAT MUST NOT BREAK
  // =========================================================================
  describe("degenerate stored values", () => {
    it("a record with no addresses reads as two empty arrays, not a throw", () => {
      seedSourceRecord({ recordId: "rec-empty", name: "No Values", emails: [] });

      expect(emailsOf("No Values")).toEqual([]);
      expect(phonesOf("No Values")).toEqual([]);
    });

    it("nulls and blanks inside the stored array never become card rows", () => {
      mockDb!
        .prepare(
          `INSERT INTO external_contacts
             (id, user_id, name, phones_json, phones_normalized_json, emails_json,
              external_record_id, source, synced_at)
           VALUES (?, ?, ?, ?, '[]', ?, ?, 'outlook', '2026-08-04T00:00:00Z')`,
        )
        .run(
          "ext-junk",
          USER_ID,
          "Junk Values",
          JSON.stringify([null, "", "  "]),
          JSON.stringify([null, "", "real@example.test", "real@example.test"]),
          "rec-junk",
        );

      expect(emailsOf("Junk Values")).toEqual(["real@example.test"]);
      expect(phonesOf("Junk Values")).toEqual([]);
    });
  });
});
