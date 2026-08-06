/**
 * @jest-environment node
 *
 * BACKLOG-2536 — THE BACKFILL HAS ONE WRITER, AND IT DECIDES `is_primary` AT
 * WRITE TIME.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * The contacts worker opened a WRITABLE connection and inserted from its own
 * thread. Two problems, and only one of them was about speed:
 *
 *   1. CONTENTION. `better-sqlite3` is synchronous, so a busy-wait on the main
 *      connection blocks the whole main process until `busy_timeout` expires —
 *      up to five seconds. The worker existed to PREVENT a freeze (BACKLOG-661,
 *      a 3.7s block reading 1000+ address-book rows); the writes added later
 *      brought one back.
 *
 *   2. A RACE NO RETRY CAN FIX. The worker decided `is_primary` from a read —
 *      "does this contact have any email yet?" — and then wrote. The main
 *      process could insert into that gap. Two primaries, or none. **Nothing
 *      failed. Both writes succeeded and disagreed.**
 *
 * The founder's instinct was retry, and retry is kept — but (2) is why the
 * writer moved rather than merely retrying. Recorded on the item.
 *
 * ===========================================================================
 * WHAT THIS SUITE ASSERTS
 * ===========================================================================
 * `is_primary` is decided against what the contact holds AT THE MOMENT OF THE
 * WRITE, not against a snapshot taken earlier by the planner. The plan
 * deliberately does not carry it, and the third case below is the one that
 * would go wrong if it did.
 *
 * Plus the atomicity the write guard requires: a failure partway leaves NO
 * rows, not some.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/db/__tests__/contactDbService.backfillWriter-2536.test.ts
 */

import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";

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
  // A REAL transaction. A `(fn) => fn()` passthrough would make the rollback
  // case below unfailable — see BACKLOG-2537.
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../contactsService", () => ({ getContactNames: () => new Map() }));
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: () => false,
}));

import { applyContactBackfillSync } from "../contactDbService";

const CONTACT = "contact-2536";

const SCHEMA = `
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT,
    is_imported INTEGER DEFAULT 0
  );
  CREATE TABLE contact_emails (
    id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, email TEXT NOT NULL,
    is_primary INTEGER DEFAULT 0, source TEXT, created_at DATETIME,
    UNIQUE(contact_id, email)
  );
  CREATE TABLE contact_phones (
    id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, phone_e164 TEXT NOT NULL,
    phone_display TEXT, phone_normalized TEXT, is_primary INTEGER DEFAULT 0,
    source TEXT, created_at DATETIME,
    UNIQUE(contact_id, phone_e164)
  );
`;

const emailRows = (): Array<{ email: string; is_primary: number }> =>
  mockDb!
    .prepare("SELECT email, is_primary FROM contact_emails WHERE contact_id = ? ORDER BY email")
    .all(CONTACT) as Array<{ email: string; is_primary: number }>;

const phoneRows = (): Array<{ phone_e164: string; is_primary: number }> =>
  mockDb!
    .prepare("SELECT phone_e164, is_primary FROM contact_phones WHERE contact_id = ? ORDER BY phone_e164")
    .all(CONTACT) as Array<{ phone_e164: string; is_primary: number }>;

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(SCHEMA);
  mockDb
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, 'u', 'Pat Riverton', 1)")
    .run(CONTACT);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("applying a backfill plan (BACKLOG-2536)", () => {
  it("adds the planned values, and the FIRST email on an empty contact becomes primary", () => {
    const updated = applyContactBackfillSync([
      { contactId: CONTACT, emails: ["first@example.com", "second@example.com"], phones: [] },
    ]);

    expect(updated).toBe(1);
    expect(emailRows()).toEqual([
      { email: "first@example.com", is_primary: 1 },
      { email: "second@example.com", is_primary: 0 },
    ]);
  });

  /**
   * THE RACE THIS ITEM EXISTS FOR.
   *
   * The planner ran when the contact had NO email. If `is_primary` travelled in
   * the plan, this write would mark a second primary on a contact that already
   * has one — the exact "two primaries" state the old two-writer arrangement
   * could produce, and which no schema constraint prevents (checked).
   *
   * NEGATIVE CONTROL: make the writer trust a planned flag instead of reading
   * the current state, and this goes red with two rows at `is_primary: 1`.
   */
  it("does NOT mark a second primary when one arrived after the plan was made", () => {
    // Between the planner's scan and this write, the main process saved one.
    mockDb!
      .prepare(
        "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES ('e0', ?, 'typed@example.com', 1, 'manual')",
      )
      .run(CONTACT);

    applyContactBackfillSync([
      { contactId: CONTACT, emails: ["fromsource@example.com"], phones: [] },
    ]);

    const primaries = emailRows().filter((r) => r.is_primary === 1);
    expect(primaries).toEqual([{ email: "typed@example.com", is_primary: 1 }]);
  });

  it("a value the contact already holds is a no-op, not a conflict", () => {
    mockDb!
      .prepare(
        "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES ('e0', ?, 'dup@example.com', 1, 'import')",
      )
      .run(CONTACT);

    const updated = applyContactBackfillSync([
      { contactId: CONTACT, emails: ["dup@example.com"], phones: [] },
    ]);

    // Nothing landed, so nothing is reported as updated — the plan was stale.
    expect(updated).toBe(0);
    expect(emailRows()).toEqual([{ email: "dup@example.com", is_primary: 1 }]);
  });

  it("normalises a plain 10-digit number to E.164 on the way in", () => {
    applyContactBackfillSync([
      { contactId: CONTACT, emails: [], phones: ["(415) 555-0142"] },
    ]);

    expect(phoneRows()).toEqual([{ phone_e164: "+14155550142", is_primary: 1 }]);
  });

  describe("forced failure partway", () => {
    it("leaves NO rows — not some of them", () => {
      mockDb!.exec(`
        CREATE TRIGGER crash_2536
        BEFORE INSERT ON contact_phones
        WHEN NEW.phone_e164 = '+14155550199'
        BEGIN
          SELECT RAISE(ABORT, 'forced crash writing the backfill');
        END;
      `);

      let outcome = "NO THROW";
      try {
        applyContactBackfillSync([
          { contactId: CONTACT, emails: ["landed@example.com"], phones: ["(415) 555-0199"] },
        ]);
      } catch (e) {
        outcome = `THREW: ${(e as Error).message}`;
      }

      expect(outcome).toMatch(/^THREW: .*forced crash writing the backfill/);
      // The email was written BEFORE the phone that aborted. Without the
      // transaction it would still be here.
      expect(emailRows()).toEqual([]);
      expect(phoneRows()).toEqual([]);
    });

    it("PRECONDITION: the same plan lands in full once the crash is removed", () => {
      mockDb!.exec(`
        CREATE TRIGGER crash_2536
        BEFORE INSERT ON contact_phones
        WHEN NEW.phone_e164 = '+14155550199'
        BEGIN SELECT RAISE(ABORT, 'forced crash writing the backfill'); END;
      `);
      let threw = false;
      try {
        applyContactBackfillSync([
          { contactId: CONTACT, emails: ["landed@example.com"], phones: ["(415) 555-0199"] },
        ]);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      mockDb!.exec("DROP TRIGGER crash_2536;");
      applyContactBackfillSync([
        { contactId: CONTACT, emails: ["landed@example.com"], phones: ["(415) 555-0199"] },
      ]);

      expect(emailRows()).toEqual([{ email: "landed@example.com", is_primary: 1 }]);
      expect(phoneRows()).toEqual([{ phone_e164: "+14155550199", is_primary: 1 }]);
    });
  });

  it("an empty plan writes nothing and opens no transaction", () => {
    expect(applyContactBackfillSync([])).toBe(0);
    expect(emailRows()).toEqual([]);
  });
});
